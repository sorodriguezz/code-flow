/**
 * Reference tables for the toolbox: HTTP status codes, MIME types by extension and well-known
 * ports. Reason phrases, media types and service names are the registries' own (IANA), so they
 * stay in English in both languages, the way they appear on the wire.
 */

export const HTTP_STATUSES: [number, string][] = [
  [100, "Continue"], [101, "Switching Protocols"], [102, "Processing"], [103, "Early Hints"],
  [200, "OK"], [201, "Created"], [202, "Accepted"], [203, "Non-Authoritative Information"], [204, "No Content"],
  [205, "Reset Content"], [206, "Partial Content"], [207, "Multi-Status"], [208, "Already Reported"], [226, "IM Used"],
  [300, "Multiple Choices"], [301, "Moved Permanently"], [302, "Found"], [303, "See Other"], [304, "Not Modified"],
  [305, "Use Proxy"], [307, "Temporary Redirect"], [308, "Permanent Redirect"],
  [400, "Bad Request"], [401, "Unauthorized"], [402, "Payment Required"], [403, "Forbidden"], [404, "Not Found"],
  [405, "Method Not Allowed"], [406, "Not Acceptable"], [407, "Proxy Authentication Required"], [408, "Request Timeout"],
  [409, "Conflict"], [410, "Gone"], [411, "Length Required"], [412, "Precondition Failed"], [413, "Content Too Large"],
  [414, "URI Too Long"], [415, "Unsupported Media Type"], [416, "Range Not Satisfiable"], [417, "Expectation Failed"],
  [418, "I'm a teapot"], [421, "Misdirected Request"], [422, "Unprocessable Content"], [423, "Locked"],
  [424, "Failed Dependency"], [425, "Too Early"], [426, "Upgrade Required"], [428, "Precondition Required"],
  [429, "Too Many Requests"], [431, "Request Header Fields Too Large"], [451, "Unavailable For Legal Reasons"],
  [499, "Client Closed Request (nginx)"],
  [500, "Internal Server Error"], [501, "Not Implemented"], [502, "Bad Gateway"], [503, "Service Unavailable"],
  [504, "Gateway Timeout"], [505, "HTTP Version Not Supported"], [506, "Variant Also Negotiates"],
  [507, "Insufficient Storage"], [508, "Loop Detected"], [510, "Not Extended"], [511, "Network Authentication Required"],
  [520, "Web Server Returned an Unknown Error (Cloudflare)"], [521, "Web Server Is Down (Cloudflare)"],
  [522, "Connection Timed Out (Cloudflare)"], [524, "A Timeout Occurred (Cloudflare)"],
];

export const MIME_TYPES: [string, string][] = [
  ["html", "text/html"], ["htm", "text/html"], ["css", "text/css"], ["js", "text/javascript"], ["mjs", "text/javascript"],
  ["json", "application/json"], ["jsonld", "application/ld+json"], ["map", "application/json"], ["xml", "application/xml"],
  ["txt", "text/plain"], ["csv", "text/csv"], ["tsv", "text/tab-separated-values"], ["md", "text/markdown"],
  ["yaml", "application/yaml"], ["yml", "application/yaml"], ["toml", "application/toml"], ["ics", "text/calendar"],
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"],
  ["avif", "image/avif"], ["svg", "image/svg+xml"], ["ico", "image/vnd.microsoft.icon"], ["bmp", "image/bmp"],
  ["tif", "image/tiff"], ["tiff", "image/tiff"], ["heic", "image/heic"],
  ["mp3", "audio/mpeg"], ["wav", "audio/wav"], ["ogg", "audio/ogg"], ["oga", "audio/ogg"], ["m4a", "audio/mp4"],
  ["flac", "audio/flac"], ["aac", "audio/aac"], ["opus", "audio/opus"], ["weba", "audio/webm"],
  ["mp4", "video/mp4"], ["webm", "video/webm"], ["ogv", "video/ogg"], ["mov", "video/quicktime"], ["avi", "video/x-msvideo"],
  ["mkv", "video/x-matroska"], ["mpeg", "video/mpeg"], ["ts", "video/mp2t"],
  ["woff", "font/woff"], ["woff2", "font/woff2"], ["ttf", "font/ttf"], ["otf", "font/otf"], ["eot", "application/vnd.ms-fontobject"],
  ["pdf", "application/pdf"], ["zip", "application/zip"], ["gz", "application/gzip"], ["tar", "application/x-tar"],
  ["7z", "application/x-7z-compressed"], ["rar", "application/vnd.rar"], ["bz2", "application/x-bzip2"], ["xz", "application/x-xz"],
  ["doc", "application/msword"], ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xls", "application/vnd.ms-excel"], ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt", "application/vnd.ms-powerpoint"], ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["odt", "application/vnd.oasis.opendocument.text"], ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ["rtf", "application/rtf"], ["epub", "application/epub+zip"],
  ["wasm", "application/wasm"], ["bin", "application/octet-stream"], ["exe", "application/vnd.microsoft.portable-executable"],
  ["dmg", "application/x-apple-diskimage"], ["apk", "application/vnd.android.package-archive"], ["jar", "application/java-archive"],
  ["sh", "application/x-sh"], ["php", "application/x-httpd-php"], ["py", "text/x-python"], ["sql", "application/sql"],
  ["graphql", "application/graphql-response+json"], ["proto", "text/x-protobuf"], ["pem", "application/x-pem-file"],
  ["crt", "application/x-x509-ca-cert"], ["cer", "application/pkix-cert"], ["p12", "application/x-pkcs12"],
  ["webmanifest", "application/manifest+json"], ["rss", "application/rss+xml"], ["atom", "application/atom+xml"],
  ["form", "application/x-www-form-urlencoded"], ["multipart", "multipart/form-data"], ["ndjson", "application/x-ndjson"],
  ["sse", "text/event-stream"],
];

export const PORTS: [number, string, string][] = [
  [20, "tcp", "FTP data"], [21, "tcp", "FTP"], [22, "tcp", "SSH / SFTP"], [23, "tcp", "Telnet"], [25, "tcp", "SMTP"],
  [53, "tcp/udp", "DNS"], [67, "udp", "DHCP server"], [68, "udp", "DHCP client"], [69, "udp", "TFTP"], [80, "tcp", "HTTP"],
  [110, "tcp", "POP3"], [123, "udp", "NTP"], [135, "tcp", "MS RPC"], [137, "udp", "NetBIOS name"], [139, "tcp", "NetBIOS session"],
  [143, "tcp", "IMAP"], [161, "udp", "SNMP"], [162, "udp", "SNMP trap"], [389, "tcp", "LDAP"], [443, "tcp/udp", "HTTPS / HTTP/3"],
  [445, "tcp", "SMB"], [465, "tcp", "SMTPS"], [514, "udp", "Syslog"], [587, "tcp", "SMTP submission"], [636, "tcp", "LDAPS"],
  [853, "tcp", "DNS over TLS"], [873, "tcp", "rsync"], [993, "tcp", "IMAPS"], [995, "tcp", "POP3S"], [1080, "tcp", "SOCKS proxy"],
  [1194, "udp", "OpenVPN"], [1433, "tcp", "SQL Server"], [1521, "tcp", "Oracle"], [1883, "tcp", "MQTT"], [2049, "tcp", "NFS"],
  [2181, "tcp", "ZooKeeper"], [2375, "tcp", "Docker (plain)"], [2376, "tcp", "Docker (TLS)"], [2379, "tcp", "etcd"],
  [3000, "tcp", "Node / Grafana / dev servers"], [3306, "tcp", "MySQL / MariaDB"], [3389, "tcp", "RDP"], [4200, "tcp", "Angular dev server"],
  [4222, "tcp", "NATS"], [5000, "tcp", "Flask / dev servers"], [5173, "tcp", "Vite dev server"], [5222, "tcp", "XMPP"],
  [5432, "tcp", "PostgreSQL"], [5601, "tcp", "Kibana"], [5672, "tcp", "AMQP (RabbitMQ)"], [5900, "tcp", "VNC"],
  [6379, "tcp", "Redis"], [6443, "tcp", "Kubernetes API"], [6881, "tcp", "BitTorrent"], [7001, "tcp", "WebLogic"],
  [8000, "tcp", "HTTP alt / Django"], [8080, "tcp", "HTTP alt / proxies"], [8081, "tcp", "HTTP alt"], [8443, "tcp", "HTTPS alt"],
  [8883, "tcp", "MQTT over TLS"], [8888, "tcp", "Jupyter"], [9000, "tcp", "SonarQube / MinIO / PHP-FPM"], [9042, "tcp", "Cassandra"],
  [9090, "tcp", "Prometheus"], [9092, "tcp", "Kafka"], [9200, "tcp", "Elasticsearch"], [9418, "tcp", "Git"],
  [10250, "tcp", "Kubelet"], [11211, "tcp", "Memcached"], [15672, "tcp", "RabbitMQ management"], [27017, "tcp", "MongoDB"],
  [50051, "tcp", "gRPC (common)"],
];

/** `1xx`…`5xx` class of a status. */
export function statusClass(code: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.floor(code / 100))) as 1 | 2 | 3 | 4 | 5;
}

export function mimeForExtension(ext: string): string | null {
  const e = ext.trim().toLowerCase().replace(/^.*\./, "");
  return MIME_TYPES.find(([x]) => x === e)?.[1] ?? null;
}
