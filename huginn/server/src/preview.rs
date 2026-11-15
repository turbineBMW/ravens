//! Link previews: fetch a web page's title, description, site name and image
//! on the user's behalf, and the image itself, without ever letting a URL
//! reach anything that isn't on the public internet.
//!
//! The server sits inside a tailnet next to the mini's own services and the
//! LAN, so every hop is checked: the URL (scheme, userinfo, host name), every
//! address its host resolves to, and every redirect. The request then goes
//! only to the addresses that were checked (the client is pinned to them, and
//! any other lookup it might try fails), so a DNS answer that changes between
//! check and connect can't move it somewhere private.

use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::Serialize;
use url::{Host, Url};

/// What a page told us about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preview {
    /// The page's URL after redirects.
    pub url: String,
    pub title: String,
    pub description: String,
    pub site: String,
    /// The page's preview image, as an absolute http(s) URL.
    pub image: Option<String>,
}

/// A fetched preview image. `content_type` is one of the four allowed types.
#[derive(Debug, Clone)]
pub struct Image {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug)]
pub enum Error {
    /// Not an http(s) URL, or one with a user name or password in it.
    BadUrl,
    /// The host is, or resolves to, an address that isn't public.
    Blocked,
    /// The request failed: DNS, connection, timeout, a bad status, too many redirects.
    Fetch(String),
    NotHtml,
    TooLarge,
    NotImage,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::BadUrl => f.write_str("not a web address that can be previewed"),
            Error::Blocked => f.write_str("that address is not on the public internet"),
            Error::Fetch(why) => write!(f, "could not fetch it: {why}"),
            Error::NotHtml => f.write_str("not a web page"),
            Error::TooLarge => f.write_str("too large"),
            Error::NotImage => f.write_str("not an image"),
        }
    }
}

impl std::error::Error for Error {}

const USER_AGENT: &str = "Huginn link preview";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REDIRECTS: usize = 3;
const MAX_PAGE: usize = 512 * 1024;
const MAX_IMAGE: usize = 2 * 1024 * 1024;
const MAX_TITLE: usize = 300;
const MAX_DESCRIPTION: usize = 500;
const MAX_SITE: usize = 300;
const MAX_IMAGE_URL: usize = 2048;

const PAGE_TYPES: &[&str] = &["text/html", "application/xhtml+xml"];
const PAGE_ACCEPT: &str = "text/html,application/xhtml+xml";
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_ACCEPT: &str = "image/png,image/jpeg,image/gif,image/webp";

/// Host names that only mean something on this machine or a private network.
const PRIVATE_SUFFIXES: &[&str] = &[
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home.arpa",
    ".ts.net",
];

/// Which addresses a request may reach: `is_public`, except in tests that
/// need to talk to a server on loopback.
type Allow = fn(IpAddr) -> bool;

/// Fetch `url` (following up to three redirects) and read its preview metadata.
pub async fn fetch_preview(url: &str) -> Result<Preview, Error> {
    within_deadline(preview_with(url, is_public)).await
}

/// Fetch an image (a page's `Preview::image`, say) under the same rules.
pub async fn fetch_image(url: &str) -> Result<Image, Error> {
    within_deadline(image_with(url, is_public)).await
}

/// The whole fetch, redirects and DNS included, gets one request's time.
async fn within_deadline<T>(work: impl Future<Output = Result<T, Error>>) -> Result<T, Error> {
    tokio::time::timeout(REQUEST_TIMEOUT, work)
        .await
        .unwrap_or_else(|_| Err(Error::Fetch("timed out".into())))
}

async fn preview_with(url: &str, allow: Allow) -> Result<Preview, Error> {
    let (url, mut response) = get(url, PAGE_ACCEPT, allow).await?;
    let content_type = header(response.headers(), CONTENT_TYPE);
    if !PAGE_TYPES.contains(&essence(&content_type).as_str()) {
        return Err(Error::NotHtml);
    }
    let (body, cut) = read_head(&mut response).await?;
    Ok(parse(&decode_body(&body, cut), &url))
}

async fn image_with(url: &str, allow: Allow) -> Result<Image, Error> {
    let (_, mut response) = get(url, IMAGE_ACCEPT, allow).await?;
    let content_type = essence(&header(response.headers(), CONTENT_TYPE));
    if !IMAGE_TYPES.contains(&content_type.as_str()) {
        return Err(Error::NotImage);
    }
    let declared = header(response.headers(), CONTENT_LENGTH)
        .trim()
        .parse::<u64>()
        .ok();
    if declared.is_some_and(|n| n > MAX_IMAGE as u64) {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::with_capacity(declared.map_or(0, |n| n as usize));
    while let Some(chunk) = response.chunk().await.map_err(fetch_error)? {
        if bytes.len() + chunk.len() > MAX_IMAGE {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    // The bytes will be served back to the browser under this type, so they
    // must really be that kind of image, not HTML or SVG wearing its label.
    if !looks_like(&content_type, &bytes) {
        return Err(Error::NotImage);
    }
    Ok(Image {
        bytes,
        content_type,
    })
}

/// GET `start`, following redirects by hand so each hop is checked. Returns
/// the final URL and its (successful) response, body unread.
async fn get(start: &str, accept: &str, allow: Allow) -> Result<(Url, reqwest::Response), Error> {
    let mut url = check(Url::parse(start.trim()).map_err(|_| Error::BadUrl)?, allow)?;
    let mut redirects = 0;
    loop {
        let response = request(&url, accept, allow).await?;
        let status = response.status();
        if is_redirect(status) {
            if redirects == MAX_REDIRECTS {
                return Err(Error::Fetch("too many redirects".into()));
            }
            redirects += 1;
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| Error::Fetch("a redirect without a usable location".into()))?;
            let next = url.join(location.trim()).map_err(|_| Error::BadUrl)?;
            url = check(next, allow)?;
            continue;
        }
        if !status.is_success() {
            return Err(Error::Fetch(format!(
                "the site answered {}",
                status.as_u16()
            )));
        }
        return Ok((url, response));
    }
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// One request to an already-checked URL, on a client that can only reach
/// the addresses its host was checked at.
async fn request(url: &Url, accept: &str, allow: Allow) -> Result<reqwest::Response, Error> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        // A proxy from the environment would do its own DNS, past our checks.
        .no_proxy()
        // Any lookup the pinned addresses don't answer fails rather than
        // falling through to the system resolver.
        .dns_resolver(Arc::new(NoLookups));
    if let Some(Host::Domain(host)) = url.host() {
        let port = url.port_or_known_default().ok_or(Error::BadUrl)?;
        let addrs = resolve(host, port, allow).await?;
        builder = builder.resolve_to_addrs(host, &addrs);
    }
    // IP-literal hosts were checked by `check` and are connected to directly.
    let client = builder.build().map_err(fetch_error)?;
    client
        .get(url.clone())
        .header(ACCEPT, accept)
        .send()
        .await
        .map_err(fetch_error)
}

/// Look `host` up and return its addresses, refusing if any one isn't allowed:
/// a name with one private answer among public ones is treated as private.
async fn resolve(host: &str, port: u16, allow: Allow) -> Result<Vec<SocketAddr>, Error> {
    let addrs: Vec<SocketAddr> =
        tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| Error::Fetch("timed out looking up the host".into()))?
            .map_err(|_| Error::Fetch("could not find the host".into()))?
            .collect();
    check_addrs(&addrs, allow)?;
    Ok(addrs)
}

fn check_addrs(addrs: &[SocketAddr], allow: Allow) -> Result<(), Error> {
    if addrs.is_empty() {
        return Err(Error::Fetch("could not find the host".into()));
    }
    if addrs.iter().any(|a| !allow(a.ip())) {
        return Err(Error::Blocked);
    }
    Ok(())
}

/// The fallback resolver: refuses every name.
struct NoLookups;

impl reqwest::dns::Resolve for NoLookups {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_string();
        Box::pin(async move { Err(format!("{name} was not checked before connecting").into()) })
    }
}

/// The URL rules: http(s), no userinfo, and a host that is neither a private
/// name nor a non-public IP literal. Resolution is checked separately.
fn check(url: Url, allow: Allow) -> Result<Url, Error> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::BadUrl);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::BadUrl);
    }
    let ok = match url.host() {
        None => return Err(Error::BadUrl),
        Some(Host::Domain(name)) => !private_name(name),
        Some(Host::Ipv4(ip)) => allow(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => allow(IpAddr::V6(ip)),
    };
    if ok {
        Ok(url)
    } else {
        Err(Error::Blocked)
    }
}

/// Names that can only mean this machine, the tailnet or the LAN. Single-label
/// names ("mini") go too: they only resolve through search domains or MagicDNS.
fn private_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    !host.contains('.')
        || host == "localhost"
        || PRIVATE_SUFFIXES
            .iter()
            .any(|s| host.ends_with(s) || host == s[1..])
}

/// Whether `ip` is an ordinary public unicast address.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => v4_is_public(ip),
        IpAddr::V6(ip) => v6_is_public(ip),
    }
}

fn v4_is_public(ip: Ipv4Addr) -> bool {
    const BLOCKED: &[([u8; 4], u32)] = &[
        ([0, 0, 0, 0], 8),          // "this network"
        ([10, 0, 0, 0], 8),         // private
        ([100, 64, 0, 0], 10),      // CGNAT, and Tailscale's addresses
        ([127, 0, 0, 0], 8),        // loopback
        ([169, 254, 0, 0], 16),     // link-local, cloud metadata
        ([172, 16, 0, 0], 12),      // private
        ([192, 0, 0, 0], 24),       // IETF protocol assignments
        ([192, 0, 2, 0], 24),       // TEST-NET-1
        ([192, 168, 0, 0], 16),     // private
        ([198, 18, 0, 0], 15),      // benchmarking
        ([198, 51, 100, 0], 24),    // TEST-NET-2
        ([203, 0, 113, 0], 24),     // TEST-NET-3
        ([224, 0, 0, 0], 4),        // multicast
        ([240, 0, 0, 0], 4),        // reserved
        ([255, 255, 255, 255], 32), // broadcast
    ];
    let ip = u32::from(ip);
    !BLOCKED
        .iter()
        .any(|&(net, len)| (ip ^ u32::from(Ipv4Addr::from(net))) >> (32 - len) == 0)
}

fn v6_is_public(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
    // Addresses that carry an IPv4 address are judged by it.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_is_public(v4); // ::ffff:0:0/96
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return v4_is_public(embedded(s[6], s[7])); // NAT64, 64:ff9b::/96
    }
    if s[0] == 0x2002 {
        return v4_is_public(embedded(s[1], s[2])); // 6to4, 2002::/16
    }
    const BLOCKED: &[(Ipv6Addr, u32)] = &[
        (Ipv6Addr::UNSPECIFIED, 128),                         // ::
        (Ipv6Addr::LOCALHOST, 128),                           // ::1
        (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0), 96),          // IPv4-compatible (deprecated)
        (Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48),  // local-use NAT64
        (Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64),      // discard-only
        (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 32),     // Teredo
        (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32), // documentation
        (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7), // unique local, Tailscale's fd7a:115c:a1e0::/48
        (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10), // link-local
        (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8), // multicast
    ];
    let n = u128::from(ip);
    if BLOCKED
        .iter()
        .any(|&(net, len)| (n ^ u128::from(net)) >> (128 - len) == 0)
    {
        return false;
    }
    // Everything public today is global unicast, 2000::/3.
    s[0] & 0xe000 == 0x2000
}

fn fetch_error(e: reqwest::Error) -> Error {
    let what = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "could not connect"
    } else {
        "the request failed"
    };
    // The innermost cause is the useful part ("connection refused", a TLS error).
    let mut cause = std::error::Error::source(&e);
    let mut innermost = None;
    while let Some(c) = cause {
        innermost = Some(c);
        cause = c.source();
    }
    match innermost {
        Some(c) => Error::Fetch(format!("{what} ({c})")),
        None => Error::Fetch(what.into()),
    }
}

fn header(headers: &HeaderMap, name: reqwest::header::HeaderName) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// "Text/HTML; charset=utf-8" -> "text/html".
fn essence(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Read the body up to `MAX_PAGE`, stopping as soon as `</head>` has arrived.
/// Also says whether reading stopped before the end of the body.
async fn read_head(response: &mut reqwest::Response) -> Result<(Vec<u8>, bool), Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(fetch_error)? {
        // `</head` may straddle chunks; look again from a little before the join.
        let from = body.len().saturating_sub(b"</head>".len());
        let room = MAX_PAGE - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= MAX_PAGE || find_end_tag(&body, from, b"head").is_some() {
            return Ok((body, true));
        }
    }
    Ok((body, false))
}

/// Pages are nearly always UTF-8; anything that isn't valid UTF-8 is read as
/// Latin-1, the usual legacy encoding. When reading stopped early (`cut`),
/// a character split at the end is dropped.
fn decode_body(bytes: &[u8], cut: bool) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(e) if cut && e.error_len().is_none() => {
            String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()
        }
        Err(_) => bytes.iter().map(|&b| char::from(b)).collect(),
    }
}

/// Whether `bytes` start the way an image of `content_type` does.
fn looks_like(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

// ---- The page parser ----------------------------------------------------

/// What the head of a page holds: its `<meta>` key/content pairs (keyed by
/// `property` and by `name`, lowercased) in document order, and its first `<title>`.
#[derive(Debug, Default)]
struct Head {
    metas: Vec<(String, String)>,
    title: Option<String>,
}

/// Build the preview from a page's HTML; `url` is where it was fetched from.
fn parse(html: &str, url: &Url) -> Preview {
    let head = scan(html);
    let meta = |keys: &[&str], max: usize| -> Option<String> {
        keys.iter().find_map(|key| {
            head.metas
                .iter()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| clean(v, max))
                .find(|v| !v.is_empty())
        })
    };
    let title = meta(&["og:title", "twitter:title"], MAX_TITLE)
        .or_else(|| head.title.as_deref().map(|t| clean(t, MAX_TITLE)))
        .unwrap_or_default();
    let description = meta(
        &["og:description", "twitter:description", "description"],
        MAX_DESCRIPTION,
    )
    .unwrap_or_default();
    let site = meta(&["og:site_name"], MAX_SITE)
        .unwrap_or_else(|| url.host_str().unwrap_or("").to_string());
    let image = [
        "og:image",
        "og:image:secure_url",
        "og:image:url",
        "twitter:image",
        "twitter:image:src",
    ]
    .iter()
    .find_map(|key| {
        head.metas
            .iter()
            .filter(|(k, _)| k == key)
            .find_map(|(_, v)| absolute_image(v, url))
    });
    Preview {
        url: url.to_string(),
        title,
        description,
        site,
        image,
    }
}

fn absolute_image(raw: &str, base: &Url) -> Option<String> {
    let raw = decode_entities(raw);
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let url = base.join(raw).ok()?;
    let ok = matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.as_str().len() <= MAX_IMAGE_URL;
    ok.then(|| url.to_string())
}

/// Elements whose content is text, not markup: skipped whole.
const RAW_TEXT: &[&str] = &[
    "script", "style", "template", "textarea", "xmp", "iframe", "noembed", "noframes",
];

/// Walk the tags of the page's head, collecting metas and the title. Stops
/// at `</head>` or `<body>`, or the end of what was read.
fn scan(html: &str) -> Head {
    let b = html.as_bytes();
    let mut head = Head::default();
    let mut i = 0;
    while let Some(lt) = b[i..].iter().position(|&c| c == b'<').map(|p| p + i) {
        let rest = &b[lt..];
        if rest.starts_with(b"<!--") {
            i = find(b, lt + 4, b"-->").map_or(b.len(), |p| p + 3);
            continue;
        }
        if rest.starts_with(b"</") {
            let (name, after) = tag_name(html, lt + 2);
            if name == "head" {
                break;
            }
            i = skip_past_gt(b, after);
            continue;
        }
        match rest.get(1) {
            Some(b'!') | Some(b'?') => {
                i = skip_past_gt(b, lt + 2);
                continue;
            }
            Some(c) if c.is_ascii_alphabetic() => {}
            _ => {
                i = lt + 1;
                continue;
            }
        }
        let (name, after) = tag_name(html, lt + 1);
        let (attrs, end) = attributes(html, after);
        i = end;
        match name.as_str() {
            "body" => break,
            "meta" => {
                let get = |key: &str| {
                    attrs
                        .iter()
                        .find(|(k, _)| k == key)
                        .map(|(_, v)| v.as_str())
                };
                if let Some(content) = get("content") {
                    for key in [get("property"), get("name")].into_iter().flatten() {
                        let key = key.trim().to_ascii_lowercase();
                        if !key.is_empty() {
                            head.metas.push((key, content.to_string()));
                        }
                    }
                }
            }
            "title" => {
                let close = find_end_tag(b, end, b"title");
                if head.title.is_none() {
                    head.title = Some(slice(html, end, close.unwrap_or(b.len())).to_string());
                }
                i = close.map_or(b.len(), |c| skip_past_gt(b, c + 2));
            }
            raw if RAW_TEXT.contains(&raw) => {
                i = find_end_tag(b, end, raw.as_bytes())
                    .map_or(b.len(), |c| skip_past_gt(b, c + 2));
            }
            _ => {}
        }
    }
    head
}

/// The lowercased tag name starting at `from`, and where it ends.
fn tag_name(html: &str, from: usize) -> (String, usize) {
    let b = html.as_bytes();
    let mut end = from;
    while end < b.len() && (b[end].is_ascii_alphanumeric() || b[end] == b'-' || b[end] == b':') {
        end += 1;
    }
    (slice(html, from, end).to_ascii_lowercase(), end)
}

/// Parse attributes from `from` up to the tag's `>`, in any order, with
/// double, single or no quotes. Returns (lowercased name, raw value) pairs
/// and the index just past the `>`.
fn attributes(html: &str, from: usize) -> (Vec<(String, String)>, usize) {
    let b = html.as_bytes();
    let n = b.len();
    let mut attrs = Vec::new();
    let mut i = from;
    loop {
        while i < n && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= n {
            return (attrs, n);
        }
        if b[i] == b'>' {
            return (attrs, i + 1);
        }
        let name_start = i;
        i += 1;
        while i < n && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let name = slice(html, name_start, i).to_ascii_lowercase();
        let mut j = i;
        while j < n && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let mut value = "";
        if j < n && b[j] == b'=' {
            j += 1;
            while j < n && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < n && (b[j] == b'"' || b[j] == b'\'') {
                let quote = b[j];
                let start = j + 1;
                let end = b[start..]
                    .iter()
                    .position(|&c| c == quote)
                    .map_or(n, |p| p + start);
                value = slice(html, start, end);
                j = (end + 1).min(n);
            } else {
                let start = j;
                while j < n && !b[j].is_ascii_whitespace() && b[j] != b'>' {
                    j += 1;
                }
                value = slice(html, start, j);
            }
            i = j;
        }
        attrs.push((name, value.to_string()));
    }
}

/// `html[from..to]`, or "" if that isn't a valid slice (it always should be:
/// every index used falls next to an ASCII byte).
fn slice(html: &str, from: usize, to: usize) -> &str {
    html.get(from..to).unwrap_or("")
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Where `</name` starts at or after `from`, case-insensitively, as a whole
/// tag name (so `</header>` isn't `</head>`).
fn find_end_tag(hay: &[u8], from: usize, name: &[u8]) -> Option<usize> {
    let len = 2 + name.len();
    let mut i = from;
    while i + len < hay.len() {
        if hay[i] == b'<'
            && hay[i + 1] == b'/'
            && hay[i + 2..i + len].eq_ignore_ascii_case(name)
            && (hay[i + len].is_ascii_whitespace() || matches!(hay[i + len], b'>' | b'/'))
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn skip_past_gt(b: &[u8], from: usize) -> usize {
    b.get(from..)
        .and_then(|rest| rest.iter().position(|&c| c == b'>'))
        .map_or(b.len(), |p| from + p + 1)
}

/// Decode entities, collapse whitespace, drop control characters, trim, and
/// cap at `max` characters.
fn clean(raw: &str, max: usize) -> String {
    let decoded = decode_entities(raw);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect();
    capped.trim_end().to_string()
}

/// Decode `&name;`, `&#123;` and `&#x7b;` in one pass (so `&amp;lt;` is `&lt;`).
/// Unknown entities are left as they are.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        match entity(after) {
            Some((c, used)) => {
                out.push(c);
                rest = &after[used..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The entity at the start of `s` (just after its `&`) and how many bytes it used.
fn entity(s: &str) -> Option<(char, usize)> {
    let semi = s.bytes().take(10).position(|c| c == b';')?;
    let name = &s[..semi];
    let c = if let Some(num) = name.strip_prefix('#') {
        let (digits, radix) = match num.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16),
            None => (num, 10),
        };
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        u32::from_str_radix(digits, radix)
            .ok()
            .and_then(char::from_u32)
            .filter(|&c| c != '\0')
            .unwrap_or('\u{fffd}')
    } else {
        match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            "nbsp" => '\u{a0}',
            "ndash" => '\u{2013}',
            "mdash" => '\u{2014}',
            "hellip" => '\u{2026}',
            "lsquo" => '\u{2018}',
            "rsquo" => '\u{2019}',
            "ldquo" => '\u{201c}',
            "rdquo" => '\u{201d}',
            "middot" => '\u{b7}',
            "bull" => '\u{2022}',
            "copy" => '\u{a9}',
            "reg" => '\u{ae}',
            "trade" => '\u{2122}',
            _ => return None,
        }
    };
    Some((c, semi + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn public_and_non_public_addresses() {
        let blocked = [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.255.255.255",
            "100.64.0.1",
            "100.101.102.103",
            "100.127.255.254",
            "127.0.0.1",
            "127.8.9.10",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
            "2001:db8::1",
            "100::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:100.100.100.100",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "::127.0.0.1",
            "2002:7f00:1::1",
            "2001::1",
            "fec0::1",
        ];
        for addr in blocked {
            assert!(!is_public(ip(addr)), "{addr} should be blocked");
        }
        let public = [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.215.14",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.0.1.1",
            "198.17.255.255",
            "198.20.0.1",
            "223.255.255.255",
            "2606:4700::1111",
            "2a00:1450:4001::200e",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::1",
        ];
        for addr in public {
            assert!(is_public(ip(addr)), "{addr} should be public");
        }
    }

    #[test]
    fn url_rules() {
        let bad = [
            "ftp://x",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "not a url",
            "http://user:pw@example.com",
            "http://user@example.com/",
            "http://:pw@example.com/",
        ];
        for url in bad {
            assert!(
                matches!(check_url(url), Err(Error::BadUrl)),
                "{url} should be a bad URL"
            );
        }
        let blocked = [
            "http://localhost/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://printer.local/",
            "http://nas.lan/",
            "http://db.internal/",
            "http://router.home.arpa/",
            "http://mini.tail339aa4.ts.net/",
            "http://ts.net/",
            "http://mini/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fd7a:115c:a1e0::1]/",
            "http://127.0.0.1:8081/",
            "http://100.101.102.103/",
            "http://169.254.169.254/latest/meta-data/",
            "http://2130706433/",
            "http://0x7f.1/",
            "http://0/",
        ];
        for url in blocked {
            assert!(
                matches!(check_url(url), Err(Error::Blocked)),
                "{url} should be blocked"
            );
        }
        for url in [
            "https://example.com/",
            "http://example.com.:8080/a?b#c",
            "http://8.8.8.8/",
        ] {
            assert!(check_url(url).is_ok(), "{url} should be allowed");
        }
    }

    fn check_url(url: &str) -> Result<Url, Error> {
        check(Url::parse(url).map_err(|_| Error::BadUrl)?, is_public)
    }

    #[tokio::test]
    async fn resolved_private_addresses_are_refused() {
        // `localhost` resolves on every machine without a network.
        assert!(matches!(
            resolve("localhost", 80, is_public).await,
            Err(Error::Blocked)
        ));
        let public: SocketAddr = "8.8.8.8:80".parse().unwrap();
        let private: SocketAddr = "10.0.0.1:80".parse().unwrap();
        assert!(check_addrs(&[public], is_public).is_ok());
        assert!(matches!(
            check_addrs(&[public, private], is_public),
            Err(Error::Blocked)
        ));
        assert!(matches!(check_addrs(&[], is_public), Err(Error::Fetch(_))));
    }

    #[tokio::test]
    async fn loopback_is_refused_without_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/");
        assert!(matches!(fetch_preview(&url).await, Err(Error::Blocked)));
        assert!(matches!(fetch_image(&url).await, Err(Error::Blocked)));
        let accepted = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "the listener should never have been connected to"
        );
    }

    // ---- End to end against a local server, with loopback let through ----

    fn loopback_too(ip: IpAddr) -> bool {
        ip.is_loopback() || is_public(ip)
    }

    struct Route {
        path: &'static str,
        response: Vec<u8>,
        /// Keep the connection open after writing, as a slow or endless body would.
        hang: bool,
    }

    fn route(path: &'static str, response: Vec<u8>) -> Route {
        Route {
            path,
            response,
            hang: false,
        }
    }

    fn http(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        if !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        {
            out.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        out.push_str("\r\n");
        let mut out = out.into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn redirect(status: &str, to: &str) -> Vec<u8> {
        http(status, &[("Location", to)], b"")
    }

    fn html(body: &str) -> Vec<u8> {
        http(
            "200 OK",
            &[("Content-Type", "text/html; charset=utf-8")],
            body.as_bytes(),
        )
    }

    /// Serve `routes` on 127.0.0.1; returns the port and the request heads seen.
    async fn serve(routes: Vec<Route>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes = Arc::new(routes);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let routes = routes.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => req.extend_from_slice(&buf[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&req).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    log.lock().unwrap().push(head);
                    let found = routes.iter().find(|r| r.path == path);
                    let response = found
                        .map_or_else(|| http("404 Not Found", &[], b""), |r| r.response.clone());
                    let _ = sock.write_all(&response).await;
                    if found.is_some_and(|r| r.hang) {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, seen)
    }

    const PAGE: &str = r#"<!doctype html><html><head>
        <meta charset="utf-8">
        <title>Fallback title</title>
        <meta property="og:title" content="Tom &amp; Jerry">
        <meta content="A cat, a mouse." property="og:description">
        <meta property='og:site_name' content='Cartoons'>
        <meta property="og:image" content="/img/cover.png">
        </head><body><meta property="og:title" content="in the body"></body></html>"#;

    #[tokio::test]
    async fn preview_follows_redirects_and_reads_the_page() {
        let (port, seen) = serve(vec![
            route("/", redirect("301 Moved Permanently", "/page")),
            route("/page", html(PAGE)),
        ])
        .await;
        let preview = preview_with(&format!("http://127.0.0.1:{port}/"), loopback_too)
            .await
            .unwrap();
        assert_eq!(
            preview,
            Preview {
                url: format!("http://127.0.0.1:{port}/page"),
                title: "Tom & Jerry".into(),
                description: "A cat, a mouse.".into(),
                site: "Cartoons".into(),
                image: Some(format!("http://127.0.0.1:{port}/img/cover.png")),
            }
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        for head in seen.iter() {
            let head = head.to_ascii_lowercase();
            assert!(
                head.contains("\r\nuser-agent: huginn link preview\r\n"),
                "{head}"
            );
            assert!(
                !head.contains("cookie") && !head.contains("referer"),
                "{head}"
            );
        }
    }

    #[tokio::test]
    async fn a_redirect_to_a_private_address_is_blocked() {
        let (port, seen) = serve(vec![
            route("/", redirect("302 Found", "http://10.0.0.1/admin")),
            route(
                "/lan",
                redirect("307 Temporary Redirect", "http://printer.local/"),
            ),
            route("/ftp", redirect("302 Found", "ftp://example.com/")),
        ])
        .await;
        let base = format!("http://127.0.0.1:{port}");
        assert!(matches!(
            preview_with(&format!("{base}/"), loopback_too).await,
            Err(Error::Blocked)
        ));
        assert!(matches!(
            preview_with(&format!("{base}/lan"), loopback_too).await,
            Err(Error::Blocked)
        ));
        assert!(matches!(
            preview_with(&format!("{base}/ftp"), loopback_too).await,
            Err(Error::BadUrl)
        ));
        assert!(matches!(
            image_with(&format!("{base}/"), loopback_too).await,
            Err(Error::Blocked)
        ));
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn at_most_three_redirects() {
        let (port, _) = serve(vec![
            route("/a0", redirect("302 Found", "/a1")),
            route("/a1", redirect("302 Found", "a2")),
            route("/a2", redirect("302 Found", "/a3")),
            route("/a3", html("<title>made it</title>")),
            route("/b0", redirect("302 Found", "/b1")),
            route("/b1", redirect("302 Found", "/b2")),
            route("/b2", redirect("302 Found", "/b3")),
            route("/b3", redirect("302 Found", "/b4")),
            route("/b4", html("<title>too far</title>")),
        ])
        .await;
        let ok = preview_with(&format!("http://127.0.0.1:{port}/a0"), loopback_too)
            .await
            .unwrap();
        assert_eq!(ok.title, "made it");
        let err = preview_with(&format!("http://127.0.0.1:{port}/b0"), loopback_too).await;
        assert!(matches!(err, Err(Error::Fetch(_))), "{err:?}");
    }

    #[tokio::test]
    async fn pages_must_be_html_and_succeed() {
        let (port, _) = serve(vec![
            route(
                "/json",
                http("200 OK", &[("Content-Type", "application/json")], b"{}"),
            ),
            route("/none", http("200 OK", &[], b"<title>x</title>")),
            route(
                "/xhtml",
                http(
                    "200 OK",
                    &[("Content-Type", "Application/XHTML+XML")],
                    b"<title>x</title>",
                ),
            ),
        ])
        .await;
        let base = format!("http://127.0.0.1:{port}");
        assert!(matches!(
            preview_with(&format!("{base}/json"), loopback_too).await,
            Err(Error::NotHtml)
        ));
        assert!(matches!(
            preview_with(&format!("{base}/none"), loopback_too).await,
            Err(Error::NotHtml)
        ));
        assert_eq!(
            preview_with(&format!("{base}/xhtml"), loopback_too)
                .await
                .unwrap()
                .title,
            "x"
        );
        assert!(matches!(
            preview_with(&format!("{base}/missing"), loopback_too).await,
            Err(Error::Fetch(_))
        ));
    }

    #[tokio::test]
    async fn reading_stops_at_the_end_of_the_head() {
        // Promises a huge body and never sends it: only stopping at </head> returns in time.
        let mut page = http(
            "200 OK",
            &[
                ("Content-Type", "text/html"),
                ("Content-Length", "100000000"),
            ],
            b"<html><head><title>Quick</title></head",
        );
        page.extend_from_slice(b">\n<body>");
        let (port, _) = serve(vec![Route {
            path: "/",
            response: page,
            hang: true,
        }])
        .await;
        let started = std::time::Instant::now();
        let preview = preview_with(&format!("http://127.0.0.1:{port}/"), loopback_too)
            .await
            .unwrap();
        assert_eq!(preview.title, "Quick");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn reading_stops_at_the_size_limit() {
        let mut body = b"<html><head><title>Big</title><meta name=description content=\"".to_vec();
        body.extend(std::iter::repeat_n(b'a', MAX_PAGE * 2));
        let page = http("200 OK", &[("Content-Type", "text/html")], &body);
        let (port, _) = serve(vec![Route {
            path: "/",
            response: page,
            hang: true,
        }])
        .await;
        let preview = preview_with(&format!("http://127.0.0.1:{port}/"), loopback_too)
            .await
            .unwrap();
        assert_eq!(preview.title, "Big");
        assert_eq!(preview.description.chars().count(), MAX_DESCRIPTION);
    }

    #[tokio::test]
    async fn images() {
        let png = b"\x89PNG\r\n\x1a\n rest of the image".to_vec();
        let big = vec![0u8; MAX_IMAGE + 1];
        let mut streamed = b"GIF89a".to_vec();
        streamed.extend(std::iter::repeat_n(0u8, MAX_IMAGE));
        // No Content-Length: the size is only found out while reading.
        let mut unsized_gif =
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: image/gif\r\n\r\n".to_vec();
        unsized_gif.extend_from_slice(&streamed);
        let (port, _) = serve(vec![
            route(
                "/png",
                http("200 OK", &[("Content-Type", "image/png")], &png),
            ),
            route("/moved", redirect("308 Permanent Redirect", "/png")),
            route(
                "/declared",
                http("200 OK", &[("Content-Type", "image/jpeg")], &big),
            ),
            route("/streamed", unsized_gif),
            route(
                "/svg",
                http("200 OK", &[("Content-Type", "image/svg+xml")], b"<svg/>"),
            ),
            route(
                "/liar",
                http(
                    "200 OK",
                    &[("Content-Type", "image/png")],
                    b"<html><script>",
                ),
            ),
            route("/page", html(PAGE)),
        ])
        .await;
        let base = format!("http://127.0.0.1:{port}");
        let image = image_with(&format!("{base}/moved"), loopback_too)
            .await
            .unwrap();
        assert_eq!(image.content_type, "image/png");
        assert_eq!(image.bytes, png);
        assert!(matches!(
            image_with(&format!("{base}/declared"), loopback_too).await,
            Err(Error::TooLarge)
        ));
        assert!(matches!(
            image_with(&format!("{base}/streamed"), loopback_too).await,
            Err(Error::TooLarge)
        ));
        assert!(matches!(
            image_with(&format!("{base}/svg"), loopback_too).await,
            Err(Error::NotImage)
        ));
        assert!(matches!(
            image_with(&format!("{base}/liar"), loopback_too).await,
            Err(Error::NotImage)
        ));
        assert!(matches!(
            image_with(&format!("{base}/page"), loopback_too).await,
            Err(Error::NotImage)
        ));
    }

    #[tokio::test]
    async fn named_hosts_connect_only_to_the_pinned_addresses() {
        let (port, seen) = serve(vec![route("/", html("<title>pinned</title>"))]).await;
        // `localhost` is refused by name at the URL check; here we go
        // straight to `request` to see the pinning itself work.
        let url = Url::parse(&format!("http://localhost:{port}/")).unwrap();
        let response = request(&url, PAGE_ACCEPT, loopback_too).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(seen.lock().unwrap().len(), 1);
        // A client with nothing pinned can't look anything up.
        let client = reqwest::Client::builder()
            .no_proxy()
            .dns_resolver(Arc::new(NoLookups))
            .build()
            .unwrap();
        assert!(client.get(url).send().await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    // ---- The parser ----

    fn page(html: &str) -> Preview {
        parse(
            html,
            &Url::parse("https://example.com/blog/post?id=1").unwrap(),
        )
    }

    #[test]
    fn attribute_order_quotes_and_case() {
        let p = page(
            r#"<head>
            <META CONTENT="Content first" PROPERTY="OG:TITLE">
            <meta content='Single quoted' name='Description'>
            <meta property=og:site_name content=Unquoted>
            </head>"#,
        );
        assert_eq!(p.title, "Content first");
        assert_eq!(p.description, "Single quoted");
        assert_eq!(p.site, "Unquoted");
        let p = page(
            r#"<meta property="og:title" content='He said "hi"' /><meta name="x" content="y" property="og:description">"#,
        );
        assert_eq!(p.title, "He said \"hi\"");
        assert_eq!(p.description, "y");
    }

    #[test]
    fn entities_and_whitespace() {
        let p = page(
            "<title>\n  Fish &amp; Chips &#8211; &#x2014;&nbsp;&lt;b&gt; &quot;q&quot; it&#39;s &apos;a&apos;\t&amp;lt; &eacute; &#0; &#xZZ; AT&T\n</title>",
        );
        assert_eq!(
            p.title,
            "Fish & Chips \u{2013} \u{2014} <b> \"q\" it's 'a' &lt; &eacute; \u{fffd} &#xZZ; AT&T"
        );
        assert_eq!(decode_entities("&#128512;&#x1F600;"), "\u{1f600}\u{1f600}");
        assert_eq!(
            decode_entities("&#+5; &#x+5; & &; &amp"),
            "&#+5; &#x+5; & &; &amp"
        );
    }

    #[test]
    fn fallbacks() {
        // No og tags: <title>, the plain description, and the host.
        let p = page(
            r#"<html><head><title>Just a title</title><meta name="description" content="Plain."></head>"#,
        );
        assert_eq!(p.title, "Just a title");
        assert_eq!(p.description, "Plain.");
        assert_eq!(p.site, "example.com");
        assert_eq!(p.image, None);
        assert_eq!(p.url, "https://example.com/blog/post?id=1");
        // twitter: beats the plain ones; og: beats twitter:; empty og: falls through.
        let p = page(
            r#"<title>T</title><meta name="twitter:title" content="Tw"><meta property="og:title" content="  ">
            <meta name="description" content="D"><meta name="twitter:description" content="TwD">"#,
        );
        assert_eq!(p.title, "Tw");
        assert_eq!(p.description, "TwD");
        // Nothing at all.
        let p = page("");
        assert_eq!(
            (p.title.as_str(), p.description.as_str(), p.site.as_str()),
            ("", "", "example.com")
        );
    }

    #[test]
    fn images_are_made_absolute() {
        let img = |tags: &str| page(tags).image;
        assert_eq!(
            img(r#"<meta property="og:image" content="/img/a.png">"#).as_deref(),
            Some("https://example.com/img/a.png")
        );
        assert_eq!(
            img(r#"<meta property="og:image" content="cover.jpg">"#).as_deref(),
            Some("https://example.com/blog/cover.jpg")
        );
        assert_eq!(
            img(r#"<meta property="og:image" content="//cdn.example.net/x.jpg">"#).as_deref(),
            Some("https://cdn.example.net/x.jpg")
        );
        assert_eq!(
            img(r#"<meta property="og:image" content="https://cdn.example.net/i?a=1&amp;b=2">"#)
                .as_deref(),
            Some("https://cdn.example.net/i?a=1&b=2")
        );
        // Not http(s): skipped for the next candidate.
        assert_eq!(
            img(r#"<meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AA"><meta name="twitter:image" content="/t.png">"#).as_deref(),
            Some("https://example.com/t.png")
        );
        assert_eq!(
            img(r#"<meta property="og:image:secure_url" content="https://example.com/s.png">"#)
                .as_deref(),
            Some("https://example.com/s.png")
        );
        assert_eq!(
            img(r#"<meta property="og:image" content="ftp://example.com/a.png">"#),
            None
        );
    }

    #[test]
    fn long_text_is_cut_by_characters() {
        let long = "é".repeat(400);
        let p = page(&format!(
            r#"<title>{long}</title><meta name="description" content="{}">"#,
            "ü".repeat(600)
        ));
        assert_eq!(p.title, "é".repeat(MAX_TITLE));
        assert_eq!(p.description, "ü".repeat(MAX_DESCRIPTION));
    }

    #[test]
    fn a_head_that_never_closes() {
        let p = page(
            r#"<html><head><meta property="og:description" content="Still here"><title>Unclosed "#,
        );
        assert_eq!(p.description, "Still here");
        assert_eq!(p.title, "Unclosed");
        let p = page(
            r#"<head><meta property="og:title" content="No end"><meta property="og:image" content="/i.png"#,
        );
        assert_eq!(p.title, "No end");
        assert_eq!(p.image.as_deref(), Some("https://example.com/i.png"));
    }

    #[test]
    fn markup_that_is_not_a_tag_is_skipped() {
        let p = page(
            r#"<head><!-- <meta property="og:title" content="comment"> -->
            <script>var s = '<meta property="og:title" content="script">'; if (a<b) {}</script>
            <style>a::before { content: "<title>style</title>"; }</style>
            <header></header><meta property="og:title" content="Real">
            </head><body><meta property="og:description" content="body"></body>"#,
        );
        assert_eq!(p.title, "Real");
        assert_eq!(p.description, "");
        // `</header>` is not the end of the head.
        assert_eq!(find_end_tag(b"</header></HEAD >", 0, b"head"), Some(9));
    }

    #[test]
    fn bodies_that_are_not_utf8() {
        assert_eq!(decode_body("héllo".as_bytes(), false), "héllo");
        assert_eq!(decode_body(b"caf\xe9", false), "café");
        assert_eq!(decode_body(b"caf\xe9 au lait", true), "café au lait");
        // A character cut in half where reading stopped.
        assert_eq!(decode_body(&"aé".as_bytes()[..2], true), "a");
    }
}
