//! What this machine has to run a local model with: how much memory, where it is, and how fast it
//! reads.
//!
//! # Why speed, and not only size
//!
//! A model that *fits* is not a model that *runs*. Writing one token reads every weight the model
//! uses once, so the pace it writes at is the bandwidth of the memory those weights sit in divided
//! by how many bytes they are — and that bandwidth differs by an order of magnitude between machines
//! that report the same number of gigabytes. Apple Silicon reads its unified memory at 100–800 GB/s
//! and a graphics card its VRAM at several hundred, while a PC whose model lives in system RAM reads
//! it at 20–90 GB/s, depending on the generation and on whether both channels are populated. The
//! same 32 GB writes a dense 32B at fifteen tokens a second on one machine and at two on another.
//!
//! So the machine is described by where a model's weights would live and how fast that memory
//! reads, and the second half is measured rather than looked up:
//!
//! * **RAM** — [`measure_ram_bandwidth`]: every core streams a buffer several times larger than any
//!   cache through `memmove`, once per session. Measured on an M4: 102–104 GB/s against the 120
//!   Apple publishes, in well under a second including the allocation.
//! * **The GPU** — on Windows, DXGI's adapter list, whatever the vendor: the bundled engine there is
//!   the Vulkan build, so an AMD or Intel card runs it as well as an NVIDIA one does. On macOS, the
//!   bundled engine's own device listing, which reports the share of unified memory Metal lets it
//!   wire (12,124 MiB of 16 GB on an M4, where the old two-thirds rule guessed 10,923). Elsewhere,
//!   `nvidia-smi`.
//!
//! Read once per session ([`machine`]) — none of it changes while the app runs.

use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;
const GB: u64 = 1_000_000_000;

/// What kind of memory a model's weights would live in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpuKind {
    /// Apple Silicon: one pool shared by CPU and GPU, of which macOS lets the GPU wire a share.
    /// Only an Apple Silicon build ever constructs it; the enum is the same wire shape everywhere,
    /// so the variant stays in the other builds rather than being configured out of them.
    #[cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), allow(dead_code))]
    Unified,
    /// A graphics card with memory of its own.
    Discrete,
    /// A GPU without memory of its own (Intel UHD or Iris, AMD Radeon 780M…). It reads system RAM at
    /// system RAM's speed, so a model is judged as if it ran on the CPU.
    Integrated,
    /// Nothing could be established. The estimate falls back to RAM, and **Probar** — which asks
    /// the server how much it actually placed on the GPU — is the real answer.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Machine {
    pub ram_bytes: u64,
    /// Bytes a second all cores together read out of RAM, measured. `None` when the measurement
    /// could not run.
    pub ram_bandwidth: Option<u64>,
    pub gpu: GpuKind,
    /// What the GPU can hold: the card's memory, or the share of unified memory Metal lets it use.
    /// `None` for an integrated GPU, which has no pool of its own.
    pub gpu_bytes: Option<u64>,
    pub gpu_name: Option<String>,
    /// Bytes a second the GPU reads its memory at: the figure Apple publishes for the chip, or
    /// [`DISCRETE_GPU_BANDWIDTH`] for a card.
    pub gpu_bandwidth: Option<u64>,
}

/// What a graphics card is assumed to read its VRAM at: a floor, not a typical figure. Nothing
/// reports a card's bandwidth, and every card worth running a model on clears it — an RTX 3050
/// reads at 224 GB/s, a 3060 at 360, a 4090 at 1,008, an RX 7600 at 288, an Arc A770 at 560. A
/// floor is enough for the question it answers: a model that fits in VRAM writes fast whichever
/// card holds it; what decides the pace is the part that does not fit, and that part is read at
/// RAM's measured speed.
pub const DISCRETE_GPU_BANDWIDTH: u64 = 200 * GB;

static MACHINE: OnceLock<Machine> = OnceLock::new();

/// This machine, read on first use. The first call measures the RAM and lists the GPUs (well under
/// a second), so it runs on a blocking thread; every later call is a copy.
pub async fn machine() -> Machine {
    if let Some(known) = MACHINE.get() {
        return known.clone();
    }
    tokio::task::spawn_blocking(machine_blocking)
        .await
        .unwrap_or_else(|_| Machine::ram_only(total_ram()))
}

/// [`machine`], for a caller that is already off the async runtime.
pub fn machine_blocking() -> Machine {
    MACHINE.get_or_init(read_machine).clone()
}

impl Machine {
    fn ram_only(ram_bytes: u64) -> Self {
        Self { ram_bytes, ram_bandwidth: None, gpu: GpuKind::Unknown, gpu_bytes: None, gpu_name: None, gpu_bandwidth: None }
    }
}

fn total_ram() -> u64 {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.total_memory()
}

fn read_machine() -> Machine {
    let ram_bytes = total_ram();
    let gpu = read_gpu(ram_bytes);
    let ram_bandwidth = measure_ram_bandwidth(ram_bytes);
    let gpu_bandwidth = match gpu.kind {
        // The CPU's own measurement is a floor for the GPU on the same memory: on a Max or an Ultra
        // the CPU cores cannot draw the whole bus, the GPU can.
        GpuKind::Unified => gpu.name.as_deref().and_then(apple_bandwidth).max(ram_bandwidth),
        GpuKind::Discrete => Some(DISCRETE_GPU_BANDWIDTH),
        GpuKind::Integrated | GpuKind::Unknown => None,
    };
    Machine { ram_bytes, ram_bandwidth, gpu: gpu.kind, gpu_bytes: gpu.bytes, gpu_name: gpu.name, gpu_bandwidth }
}

/// The GPU a model would run on, before its bandwidth is known.
#[derive(Clone, Debug, PartialEq)]
pub struct Gpu {
    pub kind: GpuKind,
    pub bytes: Option<u64>,
    pub name: Option<String>,
}

impl Gpu {
    #[cfg_attr(all(target_os = "macos", target_arch = "aarch64"), allow(dead_code))]
    fn unknown() -> Self {
        Self { kind: GpuKind::Unknown, bytes: None, name: None }
    }
}

#[cfg(windows)]
fn read_gpu(_ram_bytes: u64) -> Gpu {
    if let Some(gpu) = gpu_from_adapters(&dxgi::adapters()) {
        return gpu;
    }
    nvidia_gpu().unwrap_or_else(Gpu::unknown)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn read_gpu(ram_bytes: u64) -> Gpu {
    let listed = crate::localai::engine::list_devices().map(|out| parse_device_listing(&out)).unwrap_or_default();
    if let Some(metal) = listed.into_iter().find(|device| device.id.starts_with("MTL")) {
        return Gpu { kind: GpuKind::Unified, bytes: Some(metal.total_bytes), name: Some(metal.name) };
    }
    // No engine to ask (a partial install): the share macOS gives the GPU by default.
    Gpu {
        kind: GpuKind::Unified,
        bytes: Some(unified_gpu_share(ram_bytes)),
        name: Some(cpu_brand().unwrap_or_else(|| "Apple Silicon".to_string())),
    }
}

#[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
fn read_gpu(_ram_bytes: u64) -> Gpu {
    nvidia_gpu().unwrap_or_else(Gpu::unknown)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn cpu_brand() -> Option<String> {
    let mut system = sysinfo::System::new();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    system.cpus().first().map(|cpu| cpu.brand().trim().to_string()).filter(|brand| !brand.is_empty())
}

/// The part of unified memory macOS lets the GPU wire by default: about two thirds up to 36 GB,
/// about three quarters above. Only a fallback now — the engine reports the real figure — and
/// approximate on purpose.
#[cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), allow(dead_code))]
pub fn unified_gpu_share(ram_bytes: u64) -> u64 {
    if ram_bytes <= 36 * GIB {
        ram_bytes / 3 * 2
    } else {
        ram_bytes / 4 * 3
    }
}

/// The unified-memory bandwidth Apple publishes for a chip, from its name ("Apple M4 Pro"), in
/// bytes a second. Where a tier shipped in two bins the lower one counts, and a generation newer
/// than this table is taken to be at least as fast as the newest one in it.
pub fn apple_bandwidth(name: &str) -> Option<u64> {
    let lower = name.to_ascii_lowercase();
    let generation: u32 = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find_map(|word| word.strip_prefix('m')?.parse().ok())?;
    let tier = if lower.contains("ultra") {
        3
    } else if lower.contains("max") {
        2
    } else if lower.contains("pro") {
        1
    } else {
        0
    };
    let gbs = match (generation, tier) {
        (1, 0) => 68,
        (1, 1) | (2, 1) => 200,
        (1, 2) | (2, 2) => 400,
        (2, 0) | (3, 0) => 100,
        (3, 1) => 150,
        (3, 2) => 300,
        (3, 3) => 819,
        (4, 0) => 120,
        (_, 0) => 153,
        (_, 1) => 273,
        (_, 2) => 410,
        _ => 800,
    };
    Some(gbs * GB)
}

/// One device in `llama-server --list-devices`.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), allow(dead_code))]
pub struct EngineDevice {
    /// `MTL0`, `Vulkan0`, `CUDA0`…
    pub id: String,
    pub name: String,
    pub total_bytes: u64,
}

/// `  MTL0: Apple M4 (12124 MiB, 12123 MiB free)` → one [`EngineDevice`] per line. Devices that
/// report no memory (`BLAS: Accelerate (0 MiB, 0 MiB free)`) are not places a model can live.
#[cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), allow(dead_code))]
pub fn parse_device_listing(stdout: &str) -> Vec<EngineDevice> {
    stdout
        .lines()
        .filter_map(|line| {
            let (id, rest) = line.trim().split_once(": ")?;
            if id.is_empty() || id.contains(char::is_whitespace) {
                return None;
            }
            let open = rest.rfind(" (")?;
            let memory = rest[open + 2..].strip_suffix(')')?;
            let total_mib: u64 = memory.split(',').next()?.trim().strip_suffix("MiB")?.trim().parse().ok()?;
            Some(EngineDevice { id: id.to_string(), name: rest[..open].trim().to_string(), total_bytes: total_mib * MIB })
        })
        .filter(|device| device.total_bytes > 0)
        .collect()
}

/// One graphics adapter as Windows lists it. Kept platform-neutral so the classification below is
/// tested on every machine, not only on the one kind that has DXGI.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Adapter {
    pub name: String,
    /// PCI vendor id: 0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel, 0x1414 Microsoft.
    pub vendor: u32,
    pub dedicated_bytes: u64,
}

#[cfg_attr(not(windows), allow(dead_code))]
const VENDOR_AMD: u32 = 0x1002;
#[cfg_attr(not(windows), allow(dead_code))]
const VENDOR_MICROSOFT: u32 = 0x1414;

/// The adapter a model would run on: the card with the most memory of its own, or — when no
/// adapter has any — the integrated GPU, which reads system RAM. `None` when Windows lists no
/// hardware adapter at all (a remote session, a VM without a GPU).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn gpu_from_adapters(adapters: &[Adapter]) -> Option<Gpu> {
    // Microsoft's are the software rasteriser and the remote-display adapters: nothing to run on.
    let hardware: Vec<&Adapter> = adapters.iter().filter(|adapter| adapter.vendor != VENDOR_MICROSOFT).collect();
    if let Some(card) = hardware.iter().filter(|adapter| has_own_memory(adapter)).max_by_key(|adapter| adapter.dedicated_bytes) {
        return Some(Gpu { kind: GpuKind::Discrete, bytes: Some(card.dedicated_bytes), name: Some(card.name.clone()) });
    }
    hardware.first().map(|adapter| Gpu { kind: GpuKind::Integrated, bytes: None, name: Some(adapter.name.clone()) })
}

/// Whether an adapter has memory of its own, as opposed to a carve-out of system RAM.
///
/// 2 GB of dedicated memory is the line: an integrated GPU reports its firmware carve-out there,
/// normally 128–512 MB. AMD's APUs are the exception — a desktop board can carve out 4–16 GB, and
/// Strix Halo far more — and they are told apart by name: an APU's GPU is called for what it is
/// ("AMD Radeon 780M Graphics", "AMD Radeon(TM) Graphics"), every Radeon card is an RX or a PRO.
#[cfg_attr(not(windows), allow(dead_code))]
fn has_own_memory(adapter: &Adapter) -> bool {
    if adapter.dedicated_bytes < 2 * GIB {
        return false;
    }
    if adapter.vendor == VENDOR_AMD {
        let name = adapter.name.to_ascii_uppercase();
        return !(name.contains("GRAPHICS") && !name.contains("RX"));
    }
    true
}

#[cfg(windows)]
mod dxgi {
    use super::Adapter;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};

    /// Every hardware adapter DXGI lists. DXGI rather than WMI, whose `AdapterRAM` is a 32-bit field
    /// that reads 4 GB for any card with more, and rather than `nvidia-smi`, which sees one vendor.
    pub fn adapters() -> Vec<Adapter> {
        // SAFETY: plain COM calls on interfaces DXGI hands back, released when they drop; DXGI's
        // factory functions need no COM initialisation of the calling thread.
        let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else { return Vec::new() };
        let mut found = Vec::new();
        // `EnumAdapters1` answers DXGI_ERROR_NOT_FOUND past the last adapter; the bound is only a
        // guard against a driver that never does.
        for index in 0u32..16 {
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else { break };
            let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&unit| unit == 0).unwrap_or(desc.Description.len());
            found.push(Adapter {
                name: String::from_utf16_lossy(&desc.Description[..len]).trim().to_string(),
                vendor: desc.VendorId,
                dedicated_bytes: desc.DedicatedVideoMemory as u64,
            });
        }
        found
    }
}

/// The first NVIDIA card's name and memory, from `nvidia-smi`, when there is one.
#[cfg_attr(all(target_os = "macos", target_arch = "aarch64"), allow(dead_code))]
fn nvidia_gpu() -> Option<Gpu> {
    let output = crate::proc::std_command("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let (name, bytes) = parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout))?;
    Some(Gpu { kind: GpuKind::Discrete, bytes: Some(bytes), name: Some(name) })
}

/// `NVIDIA GeForce RTX 4090, 24564` (MiB) → the name and bytes of the first card.
pub fn parse_nvidia_smi(stdout: &str) -> Option<(String, u64)> {
    let line = stdout.lines().find(|line| !line.trim().is_empty())?;
    let (name, mib) = line.rsplit_once(',')?;
    let mib: u64 = mib.trim().parse().ok()?;
    Some((name.trim().to_string(), mib * MIB))
}

/// Timed passes over the buffer; the fastest counts. The first can be slowed by the system waking
/// cores up, a later one by another app, and neither is what the memory can do.
const PASSES: usize = 3;

/// Bytes a second this machine's cores, together, move through RAM.
///
/// The buffer is a thirty-second of the RAM, between 64 and 512 MB: at least four times the largest
/// cache a desktop CPU carries (128 MB of L3 on the X3D parts), so what is timed is RAM and not a
/// cache. It is written before it is timed — an untouched page reads as the one shared zero page,
/// from cache — and then each core moves the second half of its own slice onto the first, three
/// times; a pass runs from the first core starting to the last one finishing, and the fastest
/// counts. Every core streaming at once is what generating a token does too.
///
/// `memmove` rather than a loop of our own, because the C library's is optimised whatever this
/// build's profile is, and a loop of ours is not: summing the buffer measured 113 GB/s on an M4 in
/// a release build and 12 in a debug one — which is what `tauri dev` runs — against 102–104 for the
/// copy in both. A copy counts its bytes once read and once written, which comes to about nine
/// tenths of what a pure read reaches: an estimate built on it errs slow, never fast.
///
/// `None` when the buffer cannot be had or a thread cannot be started; never hangs.
pub fn measure_ram_bandwidth(ram_bytes: u64) -> Option<u64> {
    let size = (ram_bytes / 32).clamp(64 * MIB, 512 * MIB) as usize;
    let words = size / std::mem::size_of::<u64>();
    let mut buffer: Vec<u64> = Vec::new();
    buffer.try_reserve_exact(words).ok()?;
    buffer.resize(words, 1);
    let threads = thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 64);
    let slices: Vec<&mut [u64]> = buffer.chunks_mut(words.div_ceil(threads)).collect();
    let count = slices.len();

    // Atomics rather than a `Barrier`: a barrier waits for a party count fixed up front, so one
    // thread that fails to start would leave the others waiting for it forever.
    let released = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    let abandon = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(10);
    let spans: Option<Vec<Vec<(Instant, Instant)>>> = thread::scope(|scope| {
        let mut workers = Vec::with_capacity(count);
        for slice in slices {
            let (released, finished, abandon) = (&released, &finished, &abandon);
            let worker = thread::Builder::new().spawn_scoped(scope, move || {
                let mut spans = Vec::with_capacity(PASSES);
                let half = slice.len() / 2;
                for pass in 1..=PASSES {
                    while released.load(Ordering::Acquire) < pass {
                        if abandon.load(Ordering::Acquire) {
                            return spans;
                        }
                        thread::yield_now();
                    }
                    let start = Instant::now();
                    slice.copy_within(half.., 0);
                    black_box(&slice[..]);
                    spans.push((start, Instant::now()));
                    finished.fetch_add(1, Ordering::AcqRel);
                }
                spans
            });
            match worker {
                Ok(worker) => workers.push(worker),
                Err(_) => {
                    abandon.store(true, Ordering::Release);
                    break;
                }
            }
        }
        'passes: for pass in 1..=PASSES {
            if abandon.load(Ordering::Acquire) {
                break;
            }
            released.store(pass, Ordering::Release);
            while finished.load(Ordering::Acquire) < pass * workers.len() {
                if Instant::now() > deadline {
                    abandon.store(true, Ordering::Release);
                    break 'passes;
                }
                thread::yield_now();
            }
        }
        let spans: Vec<Vec<(Instant, Instant)>> = workers.into_iter().filter_map(|worker| worker.join().ok()).collect();
        (!abandon.load(Ordering::Acquire) && spans.len() == count).then_some(spans)
    });
    let spans = spans?;
    let best = (0..PASSES)
        .filter_map(|pass| {
            let start = spans.iter().filter_map(|worker| worker.get(pass)).map(|span| span.0).min()?;
            let end = spans.iter().filter_map(|worker| worker.get(pass)).map(|span| span.1).max()?;
            Some(end.duration_since(start))
        })
        .min()?;
    let seconds = best.as_secs_f64();
    // Half of every slice read, half written: the buffer's size, in bytes moved.
    (seconds > 0.0).then(|| (size as f64 / seconds) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(name: &str, vendor: u32, dedicated_gib: f64) -> Adapter {
        Adapter { name: name.to_string(), vendor, dedicated_bytes: (dedicated_gib * GIB as f64) as u64 }
    }

    #[test]
    fn the_engine_listing_parses_and_skips_what_holds_nothing() {
        // Verbatim from the bundled llama-server b10587 on an M4 with 16 GB.
        let listing = "Available devices:\n  MTL0: Apple M4 (12124 MiB, 12123 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n";
        assert_eq!(
            parse_device_listing(listing),
            vec![EngineDevice { id: "MTL0".into(), name: "Apple M4".into(), total_bytes: 12_124 * MIB }]
        );
        let vulkan = "  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11180 MiB free)\n";
        assert_eq!(parse_device_listing(vulkan)[0].name, "NVIDIA GeForce RTX 3060");
        assert!(parse_device_listing("Available devices:\n  (none)\n").is_empty());
        assert!(parse_device_listing("garbage: (12 GiB)").is_empty());
    }

    #[test]
    fn apple_chips_read_at_their_published_bandwidth() {
        assert_eq!(apple_bandwidth("Apple M1"), Some(68 * GB));
        assert_eq!(apple_bandwidth("Apple M4"), Some(120 * GB));
        assert_eq!(apple_bandwidth("Apple M4 Pro"), Some(273 * GB));
        assert_eq!(apple_bandwidth("Apple M3 Max"), Some(300 * GB), "the binned M3 Max");
        assert_eq!(apple_bandwidth("Apple M2 Ultra"), Some(800 * GB));
        assert_eq!(apple_bandwidth("Apple M7 Max"), Some(410 * GB), "a newer chip is at least the newest known");
        assert_eq!(apple_bandwidth("Apple Silicon"), None);
    }

    #[test]
    fn a_card_wins_over_the_integrated_gpu_beside_it() {
        let laptop = [
            adapter("Intel(R) UHD Graphics 770", 0x8086, 0.125),
            adapter("NVIDIA GeForce RTX 4060 Laptop GPU", 0x10DE, 8.0),
        ];
        let gpu = gpu_from_adapters(&laptop).expect("a GPU");
        assert_eq!(gpu.kind, GpuKind::Discrete);
        assert_eq!(gpu.name.as_deref(), Some("NVIDIA GeForce RTX 4060 Laptop GPU"));
        assert_eq!(gpu.bytes, Some(8 * GIB));
    }

    #[test]
    fn amd_and_intel_cards_count_like_nvidia_ones() {
        let amd = gpu_from_adapters(&[adapter("AMD Radeon RX 7800 XT", VENDOR_AMD, 16.0)]).unwrap();
        assert_eq!((amd.kind, amd.bytes), (GpuKind::Discrete, Some(16 * GIB)));
        let arc = gpu_from_adapters(&[adapter("Intel(R) Arc(TM) A770 Graphics", 0x8086, 16.0)]).unwrap();
        assert_eq!(arc.kind, GpuKind::Discrete);
    }

    #[test]
    fn a_gpu_without_memory_of_its_own_is_integrated() {
        let office = gpu_from_adapters(&[adapter("Intel(R) Iris(R) Xe Graphics", 0x8086, 0.125)]).unwrap();
        assert_eq!((office.kind, office.bytes), (GpuKind::Integrated, None));
        // An APU with a big firmware carve-out is still system RAM, at system RAM's speed.
        let apu = gpu_from_adapters(&[adapter("AMD Radeon 780M Graphics", VENDOR_AMD, 4.0)]).unwrap();
        assert_eq!(apu.kind, GpuKind::Integrated);
        let older = gpu_from_adapters(&[adapter("AMD Radeon(TM) Graphics", VENDOR_AMD, 2.0)]).unwrap();
        assert_eq!(older.kind, GpuKind::Integrated);
    }

    #[test]
    fn software_and_remote_adapters_are_not_gpus() {
        assert_eq!(gpu_from_adapters(&[adapter("Microsoft Basic Render Driver", VENDOR_MICROSOFT, 0.0)]), None);
        assert_eq!(gpu_from_adapters(&[]), None);
    }

    #[test]
    fn nvidia_smi_output_parses() {
        assert_eq!(
            parse_nvidia_smi("NVIDIA GeForce RTX 4090, 24564\n"),
            Some(("NVIDIA GeForce RTX 4090".to_string(), 24_564 * MIB))
        );
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("garbage"), None);
    }

    #[test]
    fn ram_bandwidth_is_measured_and_plausible() {
        // The smallest buffer (64 MB) rather than this machine's real one: it may sit partly in a
        // big cache, which the bounds below allow for, and it keeps a parallel test run from losing
        // a few hundred milliseconds of every core to this one.
        let measured = measure_ram_bandwidth(GIB).expect("the measurement runs");
        // Anything that can run a test reads RAM faster than a gigabyte a second, and nothing on
        // sale reads it faster than two terabytes.
        assert!(measured > GB, "{measured} B/s");
        assert!(measured < 2_000 * GB, "{measured} B/s");
    }

}
