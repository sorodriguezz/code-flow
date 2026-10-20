//! A trained LoRA adapter, as the GGUF file `llama-server --lora` loads.
//!
//! A PEFT adapter (what the NVIDIA trainer leaves: `adapter_model.safetensors` + `adapter_config.json`)
//! or an MLX one (`adapters.safetensors`, whose config holds `lora_parameters`) is read, each pair of
//! low-rank matrices is renamed to the base GGUF's tensor (`blk.N.attn_q.weight.lora_a`/`.lora_b`) and
//! checked against that tensor's shape, and the file is written in GGUF v3 with
//! `general.type = adapter`, `adapter.type = lora` and the alpha that makes llama.cpp's scale
//! (`alpha / rank`) equal the trainer's.
//!
//! Written here rather than by llama.cpp's `convert_lora_to_gguf.py` because that script needs torch
//! and the repository's own `gguf-py`: gigabytes and a second checkout for a renaming. What the
//! script also does — undoing the row permutation `convert_hf_to_gguf.py` applies to the *base's*
//! q/k weights for the `llama` architecture — does not apply to the bases offered here (`qwen2`,
//! `qwen3`, `nemotron_h`), whose weights reach the GGUF in Hugging Face's own row order. An
//! architecture outside [`SUPPORTED_ARCHS`] is refused rather than converted wrong.
//!
//! Layout: a PEFT `lora_A` is `[rank, in]` and `lora_B` is `[out, rank]` (row-major). GGUF lists
//! dimensions innermost first, so they are written as `ne = [in, rank]` and `[rank, out]` with the
//! bytes unchanged — what llama.cpp checks (`a.ne[0] == W.ne[0]`, `b.ne[1] == W.ne[1]`,
//! `a.ne[1] == b.ne[0]`). MLX stores the transposes (`lora_a` `[in, rank]`, `lora_b` `[rank, out]`)
//! with a `scale` instead of an alpha; they are transposed on the way in.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Architectures whose base weights reach the GGUF unpermuted, so an adapter only needs renaming.
pub const SUPPORTED_ARCHS: &[&str] = &["qwen2", "qwen3", "nemotron_h"];

const ALIGNMENT: u64 = 32;

// ---------------------------------------------------------------------------
// Reading a GGUF header
// ---------------------------------------------------------------------------

/// What a model's GGUF header says that a converter needs: its architecture and every tensor's
/// dimensions (innermost first).
#[derive(Debug, Default)]
pub struct GgufHeader {
    pub arch: Option<String>,
    pub tensors: HashMap<String, Vec<u64>>,
}

struct Reader<R: Read + Seek> {
    inner: R,
}

impl<R: Read + Seek> Reader<R> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let mut buf = [0u8; N];
        self.inner.read_exact(&mut buf).map_err(|e| format!("the GGUF header ends early: {e}"))?;
        Ok(buf)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.bytes::<8>()?))
    }
    fn string(&mut self) -> Result<String, String> {
        let len = self.u64()?;
        if len > 1 << 24 {
            return Err("a GGUF string is implausibly long".into());
        }
        let mut buf = vec![0u8; len as usize];
        self.inner.read_exact(&mut buf).map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }
    fn skip(&mut self, n: u64) -> Result<(), String> {
        self.inner.seek(SeekFrom::Current(n as i64)).map(|_| ()).map_err(|e| e.to_string())
    }
    /// Skips a value of GGUF type `kind`.
    fn skip_value(&mut self, kind: u32) -> Result<(), String> {
        match kind {
            0 | 1 | 7 => self.skip(1),
            2 | 3 => self.skip(2),
            4 | 5 | 6 => self.skip(4),
            10..=12 => self.skip(8),
            8 => {
                let len = self.u64()?;
                self.skip(len)
            }
            9 => {
                let item = self.u32()?;
                let count = self.u64()?;
                match item {
                    0 | 1 | 7 => self.skip(count),
                    2 | 3 => self.skip(count * 2),
                    4 | 5 | 6 => self.skip(count * 4),
                    10..=12 => self.skip(count * 8),
                    _ => {
                        for _ in 0..count {
                            self.skip_value(item)?;
                        }
                        Ok(())
                    }
                }
            }
            other => Err(format!("unknown GGUF value type {other}")),
        }
    }
}

/// Reads `path`'s header (never its tensor data).
pub fn read_header(path: &Path) -> Result<GgufHeader, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut r = Reader { inner: BufReader::with_capacity(1 << 20, file) };
    if &r.bytes::<4>()? != b"GGUF" {
        return Err(format!("{} is not a GGUF file", path.display()));
    }
    let version = r.u32()?;
    if version < 2 {
        return Err(format!("GGUF version {version} is too old"));
    }
    let tensor_count = r.u64()?;
    let kv_count = r.u64()?;
    let mut header = GgufHeader::default();
    for _ in 0..kv_count {
        let key = r.string()?;
        let kind = r.u32()?;
        if key == "general.architecture" && kind == 8 {
            header.arch = Some(r.string()?);
        } else {
            r.skip_value(kind)?;
        }
    }
    for _ in 0..tensor_count {
        let name = r.string()?;
        let n_dims = r.u32()?;
        if n_dims > 8 {
            return Err(format!("tensor {name} has {n_dims} dimensions"));
        }
        let dims = (0..n_dims).map(|_| r.u64()).collect::<Result<Vec<_>, _>>()?;
        let _kind = r.u32()?;
        let _offset = r.u64()?;
        header.tensors.insert(name, dims);
    }
    Ok(header)
}

// ---------------------------------------------------------------------------
// Reading safetensors
// ---------------------------------------------------------------------------

/// One tensor of a `.safetensors` file, widened to `f32`.
#[derive(Debug, Clone, PartialEq)]
pub struct Tensor {
    pub shape: Vec<usize>,
    pub data: Vec<f32>,
}

fn f16_to_f32(bits: u16) -> f32 {
    let sign = u32::from(bits >> 15) << 31;
    let exp = u32::from((bits >> 10) & 0x1f);
    let frac = u32::from(bits & 0x3ff);
    let out = match (exp, frac) {
        (0, 0) => sign,
        (0, _) => {
            // Subnormal: normalise.
            let mut e = 127 - 15 + 1;
            let mut f = frac;
            while f & 0x400 == 0 {
                f <<= 1;
                e -= 1;
            }
            sign | ((e as u32) << 23) | ((f & 0x3ff) << 13)
        }
        (0x1f, 0) => sign | 0x7f80_0000,
        (0x1f, _) => sign | 0x7fc0_0000,
        _ => sign | ((exp + 127 - 15) << 23) | (frac << 13),
    };
    f32::from_bits(out)
}

/// Reads every tensor of a `.safetensors` file (F32, F16 or BF16).
pub fn read_safetensors(path: &Path) -> Result<BTreeMap<String, Tensor>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() < 8 {
        return Err(format!("{} is too short to be safetensors", path.display()));
    }
    let header_len = u64::from_le_bytes(bytes[..8].try_into().unwrap_or_default()) as usize;
    let body = 8usize.checked_add(header_len).filter(|&end| end <= bytes.len()).ok_or("the safetensors header runs past the file")?;
    let header: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&bytes[8..body]).map_err(|e| format!("safetensors header: {e}"))?;
    let data = &bytes[body..];
    let mut out = BTreeMap::new();
    for (name, info) in header {
        if name == "__metadata__" {
            continue;
        }
        let dtype = info["dtype"].as_str().unwrap_or_default();
        let shape: Vec<usize> = info["shape"].as_array().map(|a| a.iter().filter_map(|d| d.as_u64()).map(|d| d as usize).collect()).unwrap_or_default();
        let offsets: Vec<usize> = info["data_offsets"].as_array().map(|a| a.iter().filter_map(|d| d.as_u64()).map(|d| d as usize).collect()).unwrap_or_default();
        let [start, end] = offsets[..] else { return Err(format!("{name}: no data offsets")) };
        let raw = data.get(start..end).ok_or_else(|| format!("{name}: data past the end of the file"))?;
        let count: usize = shape.iter().product();
        let values: Vec<f32> = match dtype {
            "F32" => raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect(),
            "F16" => raw.chunks_exact(2).map(|c| f16_to_f32(u16::from_le_bytes([c[0], c[1]]))).collect(),
            "BF16" => raw.chunks_exact(2).map(|c| f32::from_bits(u32::from(u16::from_le_bytes([c[0], c[1]])) << 16)).collect(),
            other => return Err(format!("{name}: unsupported dtype {other}")),
        };
        if values.len() != count {
            return Err(format!("{name}: {} values for shape {shape:?}", values.len()));
        }
        out.insert(name, Tensor { shape, data: values });
    }
    Ok(out)
}

/// Writes F32 tensors as `.safetensors`, for tests that build adapters.
#[cfg(test)]
pub fn write_safetensors(path: &Path, tensors: &BTreeMap<String, Tensor>) -> Result<(), String> {
    let mut header = serde_json::Map::new();
    let mut offset = 0usize;
    for (name, tensor) in tensors {
        let len = tensor.data.len() * 4;
        header.insert(name.clone(), serde_json::json!({ "dtype": "F32", "shape": tensor.shape, "data_offsets": [offset, offset + len] }));
        offset += len;
    }
    let mut json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    while json.len() % 8 != 0 {
        json.push(b' ');
    }
    let mut file = BufWriter::new(std::fs::File::create(path).map_err(|e| e.to_string())?);
    file.write_all(&(json.len() as u64).to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&json).map_err(|e| e.to_string())?;
    for tensor in tensors.values() {
        for v in &tensor.data {
            file.write_all(&v.to_le_bytes()).map_err(|e| e.to_string())?;
        }
    }
    file.flush().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Reading an adapter, in either trainer's shape
// ---------------------------------------------------------------------------

/// One adapted layer: `delta = (alpha / rank) · B · A`, `A` `[rank, in]`, `B` `[out, rank]`.
#[derive(Debug, Clone)]
pub struct Pair {
    /// The Hugging Face module path, `model.layers.3.self_attn.q_proj`.
    pub module: String,
    pub a: Tensor,
    pub b: Tensor,
}

#[derive(Debug, Clone)]
pub struct Adapter {
    pub rank: usize,
    /// The alpha llama.cpp needs for its `alpha / rank` to equal the trainer's scale.
    pub alpha: f32,
    pub pairs: Vec<Pair>,
    /// `peft` | `mlx`.
    pub source: &'static str,
}

fn transpose(t: &Tensor) -> Tensor {
    let [rows, cols] = t.shape[..] else { return t.clone() };
    let mut data = vec![0f32; t.data.len()];
    for r in 0..rows {
        for c in 0..cols {
            data[c * rows + r] = t.data[r * cols + c];
        }
    }
    Tensor { shape: vec![cols, rows], data }
}

/// Reads the adapter in `dir`, PEFT or MLX.
pub fn read_adapter(dir: &Path) -> Result<Adapter, String> {
    let config: serde_json::Value = std::fs::read_to_string(dir.join("adapter_config.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| format!("{} has no readable adapter_config.json", dir.display()))?;
    if dir.join("adapter_model.safetensors").is_file() {
        return read_peft(dir, &config);
    }
    if dir.join("adapters.safetensors").is_file() {
        return read_mlx(dir, &config);
    }
    Err(format!("{} holds neither a PEFT nor an MLX adapter", dir.display()))
}

fn read_peft(dir: &Path, config: &serde_json::Value) -> Result<Adapter, String> {
    if config["use_dora"].as_bool() == Some(true) {
        return Err("DoRA adapters can't be served by llama.cpp".into());
    }
    let patterns = |key: &str| config[key].as_object().is_some_and(|o| !o.is_empty());
    if patterns("rank_pattern") || patterns("alpha_pattern") {
        return Err("adapters with a rank or alpha per layer aren't supported".into());
    }
    let rank = config["r"].as_u64().ok_or("adapter_config.json has no rank (r)")? as usize;
    let lora_alpha = config["lora_alpha"].as_f64().unwrap_or(rank as f64);
    // rsLoRA scales by alpha/√r; llama.cpp divides by r, so the alpha written carries √r back.
    let alpha = if config["use_rslora"].as_bool() == Some(true) { lora_alpha * (rank as f64).sqrt() } else { lora_alpha };
    let tensors = read_safetensors(&dir.join("adapter_model.safetensors"))?;
    let mut pairs = Vec::new();
    for (name, a) in &tensors {
        let Some(module) = name.strip_suffix(".lora_A.weight") else {
            if !name.ends_with(".lora_B.weight") {
                return Err(format!("{name} isn't a LoRA matrix this converter knows"));
            }
            continue;
        };
        let b = tensors.get(&format!("{module}.lora_B.weight")).ok_or_else(|| format!("{module} has lora_A but no lora_B"))?;
        let module = module.strip_prefix("base_model.model.").unwrap_or(module).to_string();
        pairs.push(Pair { module, a: a.clone(), b: b.clone() });
    }
    Ok(Adapter { rank, alpha: alpha as f32, pairs, source: "peft" })
}

fn read_mlx(dir: &Path, config: &serde_json::Value) -> Result<Adapter, String> {
    if config["fine_tune_type"].as_str().is_some_and(|t| t != "lora") {
        return Err("only LoRA adapters (not DoRA or full fine-tunes) can be served by llama.cpp".into());
    }
    let params = &config["lora_parameters"];
    let rank = params["rank"].as_u64().unwrap_or(8) as usize;
    let scale = params["scale"].as_f64().unwrap_or(20.0);
    let tensors = read_safetensors(&dir.join("adapters.safetensors"))?;
    let mut pairs = Vec::new();
    for (name, a) in &tensors {
        let Some(module) = name.strip_suffix(".lora_a") else { continue };
        let b = tensors.get(&format!("{module}.lora_b")).ok_or_else(|| format!("{module} has lora_a but no lora_b"))?;
        // MLX: y += scale · (x · a) · b with a `[in, rank]`, b `[rank, out]`.
        pairs.push(Pair { module: module.to_string(), a: transpose(a), b: transpose(b) });
    }
    Ok(Adapter { rank, alpha: (scale * rank as f64) as f32, pairs, source: "mlx" })
}

// ---------------------------------------------------------------------------
// Naming and writing
// ---------------------------------------------------------------------------

/// The base GGUF tensor a Hugging Face module becomes, for the architectures in [`SUPPORTED_ARCHS`].
pub fn gguf_name(module: &str) -> Result<String, String> {
    let (_, rest) = module.split_once("layers.").ok_or_else(|| format!("{module}: not inside a layer"))?;
    let (index, path) = rest.split_once('.').ok_or_else(|| format!("{module}: no module after the layer"))?;
    let index: usize = index.parse().map_err(|_| format!("{module}: no layer number"))?;
    if path.contains("experts.") && !path.contains("shared_experts.") {
        return Err(format!("{module}: adapters on individual MoE experts aren't supported"));
    }
    let name = match path {
        "self_attn.q_proj" | "mixer.q_proj" => "attn_q",
        "self_attn.k_proj" | "mixer.k_proj" => "attn_k",
        "self_attn.v_proj" | "mixer.v_proj" => "attn_v",
        "self_attn.o_proj" | "mixer.o_proj" => "attn_output",
        "mlp.gate_proj" => "ffn_gate",
        "mlp.up_proj" | "mixer.up_proj" => "ffn_up",
        "mlp.down_proj" | "mixer.down_proj" => "ffn_down",
        "mixer.in_proj" => "ssm_in",
        "mixer.out_proj" => "ssm_out",
        "mixer.shared_experts.up_proj" => "ffn_up_shexp",
        "mixer.shared_experts.down_proj" => "ffn_down_shexp",
        other => return Err(format!("{module}: no GGUF tensor known for `{other}`")),
    };
    Ok(format!("blk.{index}.{name}.weight"))
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    pub arch: String,
    pub rank: usize,
    pub alpha: f32,
    pub layers: usize,
    pub source: &'static str,
}

/// Converts the adapter in `adapter_dir` into `out`, checked against the base model `base_gguf`.
pub fn convert(adapter_dir: &Path, base_gguf: &Path, out: &Path) -> Result<Converted, String> {
    let adapter = read_adapter(adapter_dir)?;
    let base = read_header(base_gguf)?;
    let arch = base.arch.clone().ok_or("the base GGUF names no architecture")?;
    if !SUPPORTED_ARCHS.contains(&arch.as_str()) {
        return Err(format!("adapters for the `{arch}` architecture can't be converted yet"));
    }
    if adapter.pairs.is_empty() {
        return Err("the adapter holds no LoRA matrices".into());
    }
    let mut tensors: Vec<(String, Vec<u64>, &[f32])> = Vec::new();
    for pair in &adapter.pairs {
        let target = gguf_name(&pair.module)?;
        let dims = base.tensors.get(&target).ok_or_else(|| format!("{}: the base has no tensor {target}", pair.module))?;
        let (&[rank_a, input], &[output, rank_b]) = (&pair.a.shape[..], &pair.b.shape[..]) else {
            return Err(format!("{}: LoRA matrices must be two-dimensional", pair.module));
        };
        let (base_in, base_out) = (dims.first().copied().unwrap_or(0), dims.get(1).copied().unwrap_or(1));
        if rank_a != rank_b || input as u64 != base_in || output as u64 != base_out {
            return Err(format!(
                "{}: A {:?} · B {:?} doesn't fit {target} {dims:?}",
                pair.module, pair.a.shape, pair.b.shape
            ));
        }
        tensors.push((format!("{target}.lora_a"), vec![input as u64, rank_a as u64], &pair.a.data));
        tensors.push((format!("{target}.lora_b"), vec![rank_b as u64, output as u64], &pair.b.data));
    }
    tensors.sort_by(|x, y| x.0.cmp(&y.0));
    write_lora_gguf(out, &arch, adapter.alpha, &tensors)?;
    Ok(Converted { arch, rank: adapter.rank, alpha: adapter.alpha, layers: adapter.pairs.len(), source: adapter.source })
}

fn put_string(out: &mut impl Write, s: &str) -> std::io::Result<()> {
    out.write_all(&(s.len() as u64).to_le_bytes())?;
    out.write_all(s.as_bytes())
}

fn pad(n: u64) -> u64 {
    (ALIGNMENT - n % ALIGNMENT) % ALIGNMENT
}

/// Writes a GGUF v3 LoRA adapter of F32 tensors (`ne` innermost first).
fn write_lora_gguf(path: &Path, arch: &str, alpha: f32, tensors: &[(String, Vec<u64>, &[f32])]) -> Result<(), String> {
    let tmp = path.with_extension("gguf.part");
    let write = || -> std::io::Result<()> {
        let mut out = BufWriter::new(std::fs::File::create(&tmp)?);
        let mut header: Vec<u8> = Vec::new();
        header.extend_from_slice(b"GGUF");
        header.extend_from_slice(&3u32.to_le_bytes());
        header.extend_from_slice(&(tensors.len() as u64).to_le_bytes());
        header.extend_from_slice(&4u64.to_le_bytes());
        for (key, value) in [("general.architecture", arch), ("general.type", "adapter"), ("adapter.type", "lora")] {
            put_string(&mut header, key)?;
            header.extend_from_slice(&8u32.to_le_bytes());
            put_string(&mut header, value)?;
        }
        put_string(&mut header, "adapter.lora.alpha")?;
        header.extend_from_slice(&6u32.to_le_bytes());
        header.extend_from_slice(&alpha.to_le_bytes());
        let mut offset = 0u64;
        for (name, dims, data) in tensors {
            put_string(&mut header, name)?;
            header.extend_from_slice(&(dims.len() as u32).to_le_bytes());
            for d in dims {
                header.extend_from_slice(&d.to_le_bytes());
            }
            header.extend_from_slice(&0u32.to_le_bytes()); // GGML_TYPE_F32
            header.extend_from_slice(&offset.to_le_bytes());
            let len = data.len() as u64 * 4;
            offset += len + pad(len);
        }
        let gap = pad(header.len() as u64);
        header.extend(std::iter::repeat_n(0u8, gap as usize));
        out.write_all(&header)?;
        for (_, _, data) in tensors {
            let mut bytes = Vec::with_capacity(data.len() * 4);
            for v in data.iter() {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let gap = pad(bytes.len() as u64);
            bytes.extend(std::iter::repeat_n(0u8, gap as usize));
            out.write_all(&bytes)?;
        }
        out.flush()
    };
    write().map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gguf-lora-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A tiny base GGUF holding `blk.0.attn_q.weight` (`ne = [in, out]`) and nothing else.
    fn base(path: &Path, arch: &str, input: u64, output: u64) {
        let data = vec![0f32; (input * output) as usize];
        write_lora_gguf(path, arch, 0.0, &[("blk.0.attn_q.weight".into(), vec![input, output], &data)]).unwrap();
    }

    fn tensor(shape: &[usize], seed: f32) -> Tensor {
        let count: usize = shape.iter().product();
        Tensor { shape: shape.to_vec(), data: (0..count).map(|i| seed + i as f32).collect() }
    }

    #[test]
    fn names_follow_llama_cpp() {
        assert_eq!(gguf_name("model.layers.3.self_attn.q_proj").unwrap(), "blk.3.attn_q.weight");
        assert_eq!(gguf_name("model.layers.0.mlp.down_proj").unwrap(), "blk.0.ffn_down.weight");
        assert_eq!(gguf_name("backbone.layers.12.mixer.in_proj").unwrap(), "blk.12.ssm_in.weight");
        assert_eq!(gguf_name("backbone.layers.5.mixer.o_proj").unwrap(), "blk.5.attn_output.weight");
        assert_eq!(gguf_name("backbone.layers.7.mixer.shared_experts.up_proj").unwrap(), "blk.7.ffn_up_shexp.weight");
        assert!(gguf_name("backbone.layers.7.mixer.experts.3.up_proj").unwrap_err().contains("experts"));
        assert!(gguf_name("lm_head").is_err());
    }

    #[test]
    fn half_floats_widen_exactly() {
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert_eq!(f16_to_f32(0x0001), 2f32.powi(-24));
        assert!(f16_to_f32(0x7c00).is_infinite());
    }

    #[test]
    fn a_peft_adapter_becomes_a_gguf_llama_cpp_accepts() {
        let d = dir("peft");
        base(&d.join("base.gguf"), "qwen3", 6, 4);
        let mut st = BTreeMap::new();
        st.insert("base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight".to_string(), tensor(&[2, 6], 0.0));
        st.insert("base_model.model.model.layers.0.self_attn.q_proj.lora_B.weight".to_string(), tensor(&[4, 2], 100.0));
        write_safetensors(&d.join("adapter_model.safetensors"), &st).unwrap();
        std::fs::write(d.join("adapter_config.json"), r#"{"r": 2, "lora_alpha": 4, "use_rslora": false}"#).unwrap();
        let converted = convert(&d, &d.join("base.gguf"), &d.join("adapter.gguf")).unwrap();
        assert_eq!(converted, Converted { arch: "qwen3".into(), rank: 2, alpha: 4.0, layers: 1, source: "peft" });
        let header = read_header(&d.join("adapter.gguf")).unwrap();
        assert_eq!(header.arch.as_deref(), Some("qwen3"));
        // llama.cpp's checks: a.ne[0] == W.ne[0], b.ne[1] == W.ne[1], a.ne[1] == b.ne[0].
        assert_eq!(header.tensors["blk.0.attn_q.weight.lora_a"], vec![6, 2]);
        assert_eq!(header.tensors["blk.0.attn_q.weight.lora_b"], vec![2, 4]);
        // The bytes are PEFT's own, row-major: A's first row is 0..6.
        let bytes = std::fs::read(d.join("adapter.gguf")).unwrap();
        let first: Vec<u8> = [0f32, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert!(bytes.windows(first.len()).any(|w| w == first.as_slice()));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn mlx_matrices_are_transposed_and_scale_becomes_alpha() {
        let d = dir("mlx");
        base(&d.join("base.gguf"), "qwen2", 6, 4);
        let mut st = BTreeMap::new();
        st.insert("model.layers.0.self_attn.q_proj.lora_a".to_string(), tensor(&[6, 2], 0.0));
        st.insert("model.layers.0.self_attn.q_proj.lora_b".to_string(), tensor(&[2, 4], 0.0));
        write_safetensors(&d.join("adapters.safetensors"), &st).unwrap();
        std::fs::write(d.join("adapter_config.json"), r#"{"fine_tune_type": "lora", "lora_parameters": {"rank": 2, "scale": 20.0}}"#).unwrap();
        let adapter = read_adapter(&d).unwrap();
        assert_eq!(adapter.alpha, 40.0);
        assert_eq!(adapter.pairs[0].a.shape, vec![2, 6]);
        // a was [[0,1],[2,3],…]; its transpose's first row is the first column: 0, 2, 4, …
        assert_eq!(&adapter.pairs[0].a.data[..3], &[0.0, 2.0, 4.0]);
        convert(&d, &d.join("base.gguf"), &d.join("adapter.gguf")).unwrap();
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_wrong_shape_or_architecture_is_refused() {
        let d = dir("refuse");
        base(&d.join("base.gguf"), "qwen3", 6, 4);
        base(&d.join("llama.gguf"), "llama", 6, 4);
        let mut st = BTreeMap::new();
        st.insert("base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight".to_string(), tensor(&[2, 5], 0.0));
        st.insert("base_model.model.model.layers.0.self_attn.q_proj.lora_B.weight".to_string(), tensor(&[4, 2], 0.0));
        write_safetensors(&d.join("adapter_model.safetensors"), &st).unwrap();
        std::fs::write(d.join("adapter_config.json"), r#"{"r": 2, "lora_alpha": 4}"#).unwrap();
        assert!(convert(&d, &d.join("base.gguf"), &d.join("a.gguf")).unwrap_err().contains("doesn't fit"));
        assert!(convert(&d, &d.join("llama.gguf"), &d.join("a.gguf")).unwrap_err().contains("llama"));
        std::fs::write(d.join("adapter_config.json"), r#"{"r": 2, "lora_alpha": 4, "use_dora": true}"#).unwrap();
        assert!(convert(&d, &d.join("base.gguf"), &d.join("a.gguf")).unwrap_err().contains("DoRA"));
        let _ = std::fs::remove_dir_all(d);
    }
}
