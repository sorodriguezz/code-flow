//! gRPC without generated stubs.
//!
//! The service is unknown until the user picks a `.proto` or the server answers reflection, so
//! there is nothing to codegen against: a `DescriptorPool` is built at runtime and messages
//! travel as `DynamicMessage` through a hand-written [`Codec`]. `protox` compiles `.proto`
//! sources in pure Rust, which is why the user never needs a `protoc` on their PATH.
//!
//! All four RPC kinds go through the same `tonic::client::Grpc::streaming` call — a unary method
//! is just a one-message request stream whose response stream yields one message — so client- and
//! bidi-streaming work without a second code path. What differs is only how `message_json` is
//! read (array vs object) and written back.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use prost::Message as _;
use prost_reflect::{
    DescriptorPool, DynamicMessage, Kind, MessageDescriptor, MethodDescriptor, SerializeOptions,
    ServiceDescriptor,
};
use prost_types::{FileDescriptorProto, FileDescriptorSet};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::de::DeserializeSeed as _;
use serde_json::{json, Value as Json};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
// `http` is not a direct dependency; tonic re-exports the crate it generates code against.
use tonic::codegen::http::uri::PathAndQuery;
use tonic::metadata::{Ascii, Binary, KeyAndValueRef, MetadataKey, MetadataMap, MetadataValue};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Uri};
use tonic::{Request, Status};

use crate::api::{
    GrpcCallRequest, GrpcDescribeRequest, GrpcMethodInfo, GrpcResponse, GrpcServiceInfo,
    NetworkOptions,
};

// ---------------------------------------------------------------------------
// Reflection wire types
// ---------------------------------------------------------------------------

/// `grpc/reflection/v1/reflection.proto`, hand-transcribed. Generating these would mean a
/// `build.rs` and a vendored `.proto` for six tiny messages whose field numbers are frozen by the
/// spec. Only the subset this module asks for is modelled — prost skips the fields left out.
mod reflection {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ServerReflectionRequest {
        #[prost(string, tag = "1")]
        pub host: String,
        #[prost(oneof = "MessageRequest", tags = "3, 4, 7")]
        pub message_request: Option<MessageRequest>,
    }

    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum MessageRequest {
        #[prost(string, tag = "3")]
        FileByFilename(String),
        #[prost(string, tag = "4")]
        FileContainingSymbol(String),
        #[prost(string, tag = "7")]
        ListServices(String),
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ServerReflectionResponse {
        #[prost(string, tag = "1")]
        pub valid_host: String,
        #[prost(oneof = "MessageResponse", tags = "4, 6, 7")]
        pub message_response: Option<MessageResponse>,
    }

    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum MessageResponse {
        #[prost(message, tag = "4")]
        FileDescriptor(FileDescriptorResponse),
        #[prost(message, tag = "6")]
        ListServices(ListServiceResponse),
        #[prost(message, tag = "7")]
        Error(ErrorResponse),
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct FileDescriptorResponse {
        #[prost(bytes = "vec", repeated, tag = "1")]
        pub file_descriptor_proto: Vec<Vec<u8>>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ListServiceResponse {
        #[prost(message, repeated, tag = "1")]
        pub service: Vec<ServiceResponse>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ServiceResponse {
        #[prost(string, tag = "1")]
        pub name: String,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ErrorResponse {
        #[prost(int32, tag = "1")]
        pub error_code: i32,
        #[prost(string, tag = "2")]
        pub error_message: String,
    }
}

const REFLECTION_V1: &str = "grpc.reflection.v1.ServerReflection";
const REFLECTION_V1ALPHA: &str = "grpc.reflection.v1alpha.ServerReflection";

/// Cap on how many times we chase a file's unresolved imports. Each round costs a network round
/// trip per missing file, and a server that keeps naming imports it never returns would otherwise
/// loop forever.
const MAX_DEPENDENCY_ROUNDS: usize = 8;

// ---------------------------------------------------------------------------
// Dynamic codec
// ---------------------------------------------------------------------------

/// The decoder needs the output descriptor to know what it is parsing; encoding needs nothing
/// because a [`DynamicMessage`] already carries its own descriptor.
struct DynamicCodec {
    output: MessageDescriptor,
}

struct DynamicEncoder;

struct DynamicDecoder(MessageDescriptor);

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder(self.output.clone())
    }
}

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("Could not encode request message: {e}")))
    }
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        DynamicMessage::decode(self.0.clone(), src)
            .map(Some)
            .map_err(|e| Status::internal(format!("Could not decode response message: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// Accepts any certificate. Only installed for `verify_ssl: false`, which is what that toggle
/// means in practice: "this is my staging box and its cert is self-signed".
#[derive(Debug)]
struct AcceptAnyServerCert;

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

/// Whatever scheme the user pasted is discarded in favour of the TLS toggle — an `http://` left
/// over from a copied command line must not silently override it.
fn endpoint_uri(endpoint: &str, use_tls: bool) -> Result<Uri, String> {
    let host = endpoint.trim();
    let host = host.split_once("://").map_or(host, |(_, rest)| rest);
    let host = host.trim_end_matches('/');
    if host.is_empty() {
        return Err("The gRPC endpoint is empty".to_string());
    }
    let scheme = if use_tls { "https" } else { "http" };
    format!("{scheme}://{host}")
        .parse::<Uri>()
        .map_err(|e| format!("`{endpoint}` is not a usable gRPC endpoint: {e}"))
}

async fn build_channel(
    endpoint: &str,
    use_tls: bool,
    authority: &str,
    options: &NetworkOptions,
) -> Result<Channel, String> {
    let uri = endpoint_uri(endpoint, use_tls)?;
    let mut ep = Endpoint::from(uri.clone());

    if options.timeout_ms > 0 {
        let limit = Duration::from_millis(options.timeout_ms);
        ep = ep.timeout(limit).connect_timeout(limit);
    }

    // `origin` is what tonic writes into `:authority` while the connection still goes to `uri` —
    // exactly the override needed to reach a host sitting behind a name-based gRPC proxy.
    let authority = authority.trim();
    if !authority.is_empty() {
        let scheme = uri.scheme_str().unwrap_or("http");
        let origin = format!("{scheme}://{authority}")
            .parse::<Uri>()
            .map_err(|e| format!("`{authority}` is not a usable :authority: {e}"))?;
        ep = ep.origin(origin);
    }

    if use_tls {
        ep = if options.verify_ssl {
            let mut tls = ClientTlsConfig::new().with_native_roots();
            if !options.ca_cert_path.trim().is_empty() {
                let pem = std::fs::read(&options.ca_cert_path).map_err(|e| {
                    format!("Could not read CA bundle {}: {e}", options.ca_cert_path)
                })?;
                tls = tls.ca_certificate(Certificate::from_pem(pem));
            }
            ep.tls_config(tls).map_err(|e| e.to_string())?
        } else {
            // tonic rejects a custom verifier combined with configured roots, so this branch has
            // to start from a bare config rather than reusing the one above.
            ep.tls_config_with_verifier(ClientTlsConfig::new(), Arc::new(AcceptAnyServerCert))
                .map_err(|e| e.to_string())?
        };
    }

    // tonic's own `Display` is just "transport error"; the reason lives at the bottom of the
    // chain, and an unreachable host deserves the same sentence here as it gets over HTTP.
    ep.connect().await.map_err(|e| {
        crate::api::describe_transport_error(
            &format!("Could not connect to {uri}"),
            uri.host().unwrap_or(""),
            uri.port_u16().or_else(|| match uri.scheme_str() {
                Some("https") => Some(443),
                Some("http") => Some(80),
                _ => None,
            }),
            &e,
        )
    })
}

fn apply_metadata(map: &mut MetadataMap, entries: &[(String, String)]) -> Result<(), String> {
    for (raw_key, value) in entries {
        let name = raw_key.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        // gRPC reserves the `-bin` suffix for values that travel base64-encoded, and tonic refuses
        // to build an ASCII key carrying it, so the two cases cannot share a branch.
        if name.ends_with("-bin") {
            let decoded = BASE64
                .decode(value.as_bytes())
                .map_err(|e| format!("Metadata `{name}` ends in -bin so it must be base64: {e}"))?;
            let key = MetadataKey::<Binary>::from_bytes(name.as_bytes())
                .map_err(|e| format!("Invalid metadata key `{name}`: {e}"))?;
            map.insert_bin(key, MetadataValue::from_bytes(&decoded));
        } else {
            let key = MetadataKey::<Ascii>::from_bytes(name.as_bytes())
                .map_err(|e| format!("Invalid metadata key `{name}`: {e}"))?;
            let value = MetadataValue::try_from(value.as_str())
                .map_err(|e| format!("Invalid metadata value for `{name}`: {e}"))?;
            map.insert(key, value);
        }
    }
    Ok(())
}

fn metadata_pairs(map: &MetadataMap) -> Vec<(String, String)> {
    map.iter()
        .map(|entry| match entry {
            KeyAndValueRef::Ascii(key, value) => (
                key.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            ),
            // Binary values stay in their on-the-wire base64 form: the panel renders metadata as
            // text and a decoded blob would be unreadable there anyway.
            KeyAndValueRef::Binary(key, value) => (
                key.as_str().to_string(),
                String::from_utf8_lossy(value.as_encoded_bytes()).into_owned(),
            ),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

fn pool_from_proto(proto_path: &str, import_paths: &[String]) -> Result<DescriptorPool, String> {
    let path = Path::new(proto_path.trim());
    if !path.is_file() {
        return Err(format!("Proto file not found: {proto_path}"));
    }

    let mut includes: Vec<PathBuf> = import_paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| PathBuf::from(p.trim()))
        .collect();

    // protox resolves the target file *through* the include paths and refuses to open one that
    // lives under none of them. Appending the file's own directory last keeps the caller's paths
    // authoritative for naming while making a lone `.proto` always openable.
    if let Some(parent) = path.parent() {
        if !includes.iter().any(|include| include == parent) {
            includes.push(parent.to_path_buf());
        }
    }

    let set = protox::compile([path], includes)
        .map_err(|e| format!("Could not compile {proto_path}: {e}"))?;
    DescriptorPool::from_file_descriptor_set(set)
        .map_err(|e| format!("Could not build a descriptor pool from {proto_path}: {e}"))
}

/// One reflection round trip. The service is bidi-streaming, but every question asked here is a
/// single request with a single answer, so each call gets its own short-lived stream.
async fn reflect(
    channel: &Channel,
    metadata: &[(String, String)],
    service: &str,
    message_request: reflection::MessageRequest,
) -> Result<reflection::MessageResponse, String> {
    let path = format!("/{service}/ServerReflectionInfo")
        .parse::<PathAndQuery>()
        .map_err(|e| e.to_string())?;

    let mut client = tonic::client::Grpc::new(channel.clone());
    client.ready().await.map_err(|e| e.to_string())?;

    let mut request = Request::new(reflection::ServerReflectionRequest {
        host: String::new(),
        message_request: Some(message_request),
    });
    apply_metadata(request.metadata_mut(), metadata)?;

    let codec = tonic_prost::ProstCodec::<
        reflection::ServerReflectionRequest,
        reflection::ServerReflectionResponse,
    >::default();

    let mut stream = client
        .server_streaming(request, path, codec)
        .await
        .map_err(|status| status.to_string())?
        .into_inner();

    let response = stream
        .message()
        .await
        .map_err(|status| status.to_string())?
        .ok_or_else(|| "The reflection service closed the stream without answering".to_string())?;

    match response.message_response {
        Some(reflection::MessageResponse::Error(err)) => Err(format!(
            "Reflection error {}: {}",
            err.error_code, err.error_message
        )),
        Some(other) => Ok(other),
        None => Err("The reflection service returned an empty response".to_string()),
    }
}

async fn list_services(
    channel: &Channel,
    metadata: &[(String, String)],
    service: &str,
) -> Result<Vec<String>, String> {
    let request = reflection::MessageRequest::ListServices(String::new());
    match reflect(channel, metadata, service, request).await? {
        reflection::MessageResponse::ListServices(list) => {
            Ok(list.service.into_iter().map(|s| s.name).collect())
        }
        _ => Err("The reflection service answered list_services with the wrong message".to_string()),
    }
}

async fn fetch_files(
    channel: &Channel,
    metadata: &[(String, String)],
    service: &str,
    request: reflection::MessageRequest,
) -> Result<Vec<FileDescriptorProto>, String> {
    match reflect(channel, metadata, service, request).await? {
        reflection::MessageResponse::FileDescriptor(files) => files
            .file_descriptor_proto
            .iter()
            .map(|bytes| {
                FileDescriptorProto::decode(bytes.as_slice())
                    .map_err(|e| format!("Malformed file descriptor from the server: {e}"))
            })
            .collect(),
        _ => Err("The reflection service answered with the wrong message".to_string()),
    }
}

async fn pool_from_reflection(
    channel: &Channel,
    metadata: &[(String, String)],
) -> Result<DescriptorPool, String> {
    // Servers in the wild register one reflection version or the other and rarely both, and the
    // only way to tell them apart is to ask and see whether it comes back UNIMPLEMENTED.
    let (service, names) = match list_services(channel, metadata, REFLECTION_V1).await {
        Ok(names) => (REFLECTION_V1, names),
        Err(v1_error) => match list_services(channel, metadata, REFLECTION_V1ALPHA).await {
            Ok(names) => (REFLECTION_V1ALPHA, names),
            Err(alpha_error) => {
                return Err(format!(
                    "Server reflection is not available (v1: {v1_error}; v1alpha: {alpha_error})"
                ))
            }
        },
    };

    let mut files: HashMap<String, FileDescriptorProto> = HashMap::new();
    for name in &names {
        let request = reflection::MessageRequest::FileContainingSymbol(name.clone());
        for file in fetch_files(channel, metadata, service, request).await? {
            files.entry(file.name().to_string()).or_insert(file);
        }
    }

    // `file_containing_symbol` is specified to return the transitive closure, but several server
    // implementations send only the one file, so any import still missing gets chased by name
    // until the set closes over itself.
    for _ in 0..MAX_DEPENDENCY_ROUNDS {
        let missing: HashSet<String> = files
            .values()
            .flat_map(|file| file.dependency.iter())
            .filter(|dep| !files.contains_key(*dep))
            .cloned()
            .collect();
        if missing.is_empty() {
            break;
        }

        let known = files.len();
        for name in missing {
            let request = reflection::MessageRequest::FileByFilename(name);
            let Ok(fetched) = fetch_files(channel, metadata, service, request).await else {
                continue;
            };
            for file in fetched {
                files.entry(file.name().to_string()).or_insert(file);
            }
        }
        if files.len() == known {
            break;
        }
    }

    let set = FileDescriptorSet {
        file: files.into_values().collect(),
    };
    DescriptorPool::from_file_descriptor_set(set).map_err(|e| {
        format!("The descriptors returned by reflection do not form a complete set: {e}")
    })
}

// ---------------------------------------------------------------------------
// Example messages
// ---------------------------------------------------------------------------

/// Well-known types have a JSON form that is nothing like their field layout, so a skeleton built
/// out of their fields would be rejected the moment the user pressed Send.
fn well_known_example(full_name: &str) -> Option<Json> {
    Some(match full_name {
        "google.protobuf.Timestamp" => json!("1970-01-01T00:00:00Z"),
        "google.protobuf.Duration" => json!("0s"),
        "google.protobuf.FieldMask"
        | "google.protobuf.StringValue"
        | "google.protobuf.BytesValue" => json!(""),
        "google.protobuf.Empty" | "google.protobuf.Struct" => json!({}),
        "google.protobuf.Value" => Json::Null,
        "google.protobuf.ListValue" => json!([]),
        "google.protobuf.Any" => json!({ "@type": "" }),
        "google.protobuf.BoolValue" => json!(false),
        "google.protobuf.DoubleValue" | "google.protobuf.FloatValue" => json!(0.0),
        "google.protobuf.Int32Value"
        | "google.protobuf.Int64Value"
        | "google.protobuf.UInt32Value"
        | "google.protobuf.UInt64Value" => json!(0),
        _ => return None,
    })
}

fn example_value(kind: &Kind, depth: usize) -> Json {
    match kind {
        Kind::Message(desc) => example_message(desc, depth),
        Kind::Enum(desc) => json!(desc.default_value().name()),
        Kind::Bool => json!(false),
        Kind::String | Kind::Bytes => json!(""),
        Kind::Double | Kind::Float => json!(0.0),
        _ => json!(0),
    }
}

/// `depth` counts how far into nested messages we already are. Anything past the first level
/// collapses to `{}`: a fully expanded skeleton of a deeply nested type is useless as a starting
/// point, and a self-referential message would never terminate.
fn example_message(desc: &MessageDescriptor, depth: usize) -> Json {
    if let Some(known) = well_known_example(desc.full_name()) {
        return known;
    }
    if depth > 1 {
        return json!({});
    }

    let mut object = serde_json::Map::new();
    for field in desc.fields() {
        let value = if field.is_map() {
            json!({})
        } else if field.is_list() {
            json!([])
        } else {
            example_value(&field.kind(), depth + 1)
        };
        object.insert(field.json_name().to_string(), value);
    }
    Json::Object(object)
}

fn services_from_pool(pool: &DescriptorPool) -> Vec<GrpcServiceInfo> {
    pool.services()
        .map(|service| GrpcServiceInfo {
            name: service.full_name().to_string(),
            methods: service
                .methods()
                .map(|method| {
                    let input = method.input();
                    GrpcMethodInfo {
                        name: method.name().to_string(),
                        full_name: method.full_name().to_string(),
                        client_streaming: method.is_client_streaming(),
                        server_streaming: method.is_server_streaming(),
                        input_example: serde_json::to_string_pretty(&example_message(&input, 0))
                            .unwrap_or_else(|_| "{}".to_string()),
                        input_type: input.full_name().to_string(),
                        output_type: method.output().full_name().to_string(),
                    }
                })
                .collect(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

fn find_service(pool: &DescriptorPool, name: &str) -> Result<ServiceDescriptor, String> {
    let wanted = name.trim().trim_start_matches('.');
    pool.get_service_by_name(wanted)
        .or_else(|| pool.services().find(|service| service.name() == wanted))
        .ok_or_else(|| format!("Service `{name}` is not defined in the descriptor"))
}

fn find_method(service: &ServiceDescriptor, name: &str) -> Result<MethodDescriptor, String> {
    let wanted = name.trim().trim_start_matches('.');
    service
        .methods()
        .find(|method| method.name() == wanted || method.full_name() == wanted)
        .ok_or_else(|| format!("Method `{name}` is not defined on {}", service.full_name()))
}

fn parse_messages(
    desc: &MessageDescriptor,
    message_json: &str,
    client_streaming: bool,
) -> Result<Vec<DynamicMessage>, String> {
    let body = message_json.trim();
    let root: Json = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_str(body).map_err(|e| format!("The request body is not valid JSON: {e}"))?
    };

    let items = match root {
        Json::Array(items) => items,
        single => vec![single],
    };
    if !client_streaming && items.len() > 1 {
        return Err(format!(
            "{} messages were supplied but this method is not client-streaming",
            items.len()
        ));
    }

    items
        .iter()
        .map(|item| {
            desc.clone()
                .deserialize(item)
                .map_err(|e| format!("The request does not match {}: {e}", desc.full_name()))
        })
        .collect()
}

fn messages_to_json(messages: &[DynamicMessage], as_array: bool) -> Result<String, String> {
    // Defaults are kept so the panel shows the whole shape of the reply; a message that happens to
    // be all zeroes would otherwise render as `{}` and read like an empty response.
    let options = SerializeOptions::new().skip_default_fields(false);
    let mut encoded = Vec::with_capacity(messages.len());
    for message in messages {
        let value = message
            .serialize_with_options(serde_json::value::Serializer, &options)
            .map_err(|e| format!("Could not render the response as JSON: {e}"))?;
        encoded.push(value);
    }

    let value = if as_array {
        Json::Array(encoded)
    } else {
        match encoded.into_iter().next() {
            Some(value) => value,
            None => return Ok(String::new()),
        }
    };
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

/// Lists every service and method reachable from a `.proto` file or from server reflection.
pub async fn describe(req: GrpcDescribeRequest) -> Result<Vec<GrpcServiceInfo>, String> {
    let pool = match req.source.as_str() {
        "proto" => pool_from_proto(&req.proto_path, &req.import_paths)?,
        "reflection" => {
            let channel = build_channel(&req.endpoint, req.use_tls, "", &req.options).await?;
            pool_from_reflection(&channel, &req.metadata).await?
        }
        other => {
            return Err(format!(
                "Unknown gRPC descriptor source `{other}` (expected `proto` or `reflection`)"
            ))
        }
    };
    Ok(services_from_pool(&pool))
}

/// Invokes one method. Unary, client-, server- and bidi-streaming all resolve to the same
/// streaming call. A non-OK gRPC status comes back as a populated [`GrpcResponse`], not an `Err`,
/// because the UI presents it the way it presents an HTTP 500.
pub async fn call(req: GrpcCallRequest) -> Result<GrpcResponse, String> {
    let timeout = req.options.timeout_ms;
    if timeout == 0 {
        return call_inner(req).await;
    }
    // `Endpoint::timeout` only covers the response headers; on a streaming method the body could
    // still hang forever, so the whole call is wrapped as well.
    tokio::time::timeout(Duration::from_millis(timeout), call_inner(req))
        .await
        .map_err(|_| format!("The gRPC call timed out after {timeout}ms"))?
}

async fn call_inner(req: GrpcCallRequest) -> Result<GrpcResponse, String> {
    // Connect and RPC are timed separately so that loading descriptors — which for a reflection
    // source costs several round trips of its own — stays out of the number the UI reports.
    let connecting = Instant::now();
    let channel = build_channel(&req.endpoint, req.use_tls, &req.authority, &req.options).await?;
    let connect_elapsed = connecting.elapsed();

    let pool = match req.source.as_str() {
        "proto" => pool_from_proto(&req.proto_path, &req.import_paths)?,
        // Reflection reuses the channel that is about to carry the call itself.
        "reflection" => pool_from_reflection(&channel, &req.metadata).await?,
        other => {
            return Err(format!(
                "Unknown gRPC descriptor source `{other}` (expected `proto` or `reflection`)"
            ))
        }
    };

    let service = find_service(&pool, &req.service)?;
    let method = find_method(&service, &req.method)?;
    let messages = parse_messages(
        &method.input(),
        &req.message_json,
        method.is_client_streaming(),
    )?;

    let path = format!("/{}/{}", service.full_name(), method.name())
        .parse::<PathAndQuery>()
        .map_err(|e| e.to_string())?;

    let mut client = tonic::client::Grpc::new(channel);
    client
        .ready()
        .await
        .map_err(|e| format!("The gRPC channel never became ready: {e}"))?;
    let calling = Instant::now();

    let mut request = Request::new(tokio_stream::iter(messages));
    apply_metadata(request.metadata_mut(), &req.metadata)?;

    let codec = DynamicCodec {
        output: method.output(),
    };

    let mut headers = Vec::new();
    let mut trailers = Vec::new();
    let mut status_code = 0;
    let mut status_message = String::new();
    let mut received = Vec::new();

    match client.streaming(request, path, codec).await {
        Ok(response) => {
            headers = metadata_pairs(response.metadata());
            let mut stream = response.into_inner();
            loop {
                match stream.message().await {
                    Ok(Some(message)) => received.push(message),
                    Ok(None) => {
                        if let Ok(Some(map)) = stream.trailers().await {
                            trailers = metadata_pairs(&map);
                        }
                        break;
                    }
                    Err(status) => {
                        status_code = status.code() as i32;
                        status_message = status.message().to_string();
                        trailers = metadata_pairs(status.metadata());
                        break;
                    }
                }
            }
        }
        // A trailers-only failure never produced a response body, so there are no initial headers
        // to report: everything the server said is carried on the status itself.
        Err(status) => {
            status_code = status.code() as i32;
            status_message = status.message().to_string();
            trailers = metadata_pairs(status.metadata());
        }
    }

    Ok(GrpcResponse {
        message_json: messages_to_json(&received, method.is_server_streaming())?,
        status_code,
        status_message,
        headers,
        trailers,
        duration_ms: (connect_elapsed + calling.elapsed()).as_millis() as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
        syntax = "proto3";
        package demo;
        import "google/protobuf/timestamp.proto";

        enum Tier { TIER_FREE = 0; TIER_PAID = 1; }

        message Address { string city = 1; Address next = 2; }

        message Hello {
          string name = 1;
          int64 count = 2;
          Tier tier = 3;
          Address address = 4;
          repeated string tags = 5;
          map<string, int32> scores = 6;
          google.protobuf.Timestamp at = 7;
        }

        message Reply { string text = 1; }

        service Greeter {
          rpc Unary(Hello) returns (Reply);
          rpc Down(Hello) returns (stream Reply);
          rpc Up(stream Hello) returns (Reply);
        }
    "#;

    #[test]
    fn describes_a_proto_file() {
        let dir = std::env::temp_dir().join(format!("cf-grpc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demo.proto");
        std::fs::write(&path, SAMPLE).unwrap();

        let pool = pool_from_proto(path.to_str().unwrap(), &[]).unwrap();
        let services = services_from_pool(&pool);
        let greeter = services.iter().find(|s| s.name == "demo.Greeter").unwrap();
        assert_eq!(greeter.methods.len(), 3);

        let down = greeter.methods.iter().find(|m| m.name == "Down").unwrap();
        assert!(down.server_streaming && !down.client_streaming);
        let up = greeter.methods.iter().find(|m| m.name == "Up").unwrap();
        assert!(up.client_streaming && !up.server_streaming);

        let example: Json = serde_json::from_str(&down.input_example).unwrap();
        assert_eq!(example["name"], json!(""));
        assert_eq!(example["count"], json!(0));
        assert_eq!(example["tier"], json!("TIER_FREE"));
        assert_eq!(example["tags"], json!([]));
        assert_eq!(example["scores"], json!({}));
        assert_eq!(example["at"], json!("1970-01-01T00:00:00Z"));
        // One level of recursion: `address` expands, but the `next` inside it collapses.
        assert_eq!(example["address"]["city"], json!(""));
        assert_eq!(example["address"]["next"], json!({}));

        let hello = pool.get_message_by_name("demo.Hello").unwrap();
        let parsed = parse_messages(&hello, &down.input_example, false).unwrap();
        assert_eq!(parsed.len(), 1);
        let rendered = messages_to_json(&parsed, true).unwrap();
        assert!(rendered.starts_with('['));

        assert!(parse_messages(&hello, "[{}, {}]", false).is_err());
        assert_eq!(parse_messages(&hello, "[{}, {}]", true).unwrap().len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reflection messages are transcribed by hand, so nothing but this test stands between a
    /// mistyped tag number and a server that answers every question with an error.
    #[test]
    fn reflection_messages_match_the_wire_format() {
        let request = reflection::ServerReflectionRequest {
            host: String::new(),
            message_request: Some(reflection::MessageRequest::ListServices(String::new())),
        };
        // Field 7, length-delimited: (7 << 3) | 2 = 0x3A, then an empty string.
        assert_eq!(request.encode_to_vec(), vec![0x3A, 0x00]);

        let request = reflection::ServerReflectionRequest {
            host: String::new(),
            message_request: Some(reflection::MessageRequest::FileContainingSymbol("ab".into())),
        };
        assert_eq!(request.encode_to_vec(), vec![0x22, 0x02, b'a', b'b']);

        let request = reflection::ServerReflectionRequest {
            host: String::new(),
            message_request: Some(reflection::MessageRequest::FileByFilename("ab".into())),
        };
        assert_eq!(request.encode_to_vec(), vec![0x1A, 0x02, b'a', b'b']);

        // A `list_services_response` (field 6) holding one service named "a", preceded by the
        // `original_request` (field 2) this module deliberately does not model.
        let wire = [
            0x12, 0x02, 0x3A, 0x00, // 2: original_request { 7: "" }
            0x32, 0x05, 0x0A, 0x03, 0x0A, 0x01, b'a', // 6: { 1: { 1: "a" } }
        ];
        let response = reflection::ServerReflectionResponse::decode(wire.as_slice()).unwrap();
        match response.message_response {
            Some(reflection::MessageResponse::ListServices(list)) => {
                assert_eq!(list.service.len(), 1);
                assert_eq!(list.service[0].name, "a");
            }
            other => panic!("decoded the wrong response variant: {other:?}"),
        }
    }
}
