//! `ctx.http.fetch(url, {method, headers, body})` → `{status, headers, body}` (PLUGIN-ENGINE.md §4.1,
//! §8). HTTPS only, to a host the sheet named (`uses.network.hosts`) on its usual port, or to an
//! address the user listed in a setting `uses.network.hosts_from` names (plain HTTP only to such
//! an address inside the user's own network). Redirects are answered, never followed; an answer
//! stops at 10 MB and a request at 60 s.
use super::{bad, permission, Granted};
use crate::plugins::host::{ErrorCode, HostError};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BYTES: usize = 10 * 1024 * 1024;
const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/// The HTTP client plugins share: no redirects, no cookies, 60 s a request.
pub struct Client {
    inner: reqwest::Client,
    max_bytes: usize,
    /// Tests only: an allowed `https://` host is reached at a loopback `http://` address
    /// instead, after the grant was checked on the real address.
    test_hosts: HashMap<String, String>,
    /// Tests only: no request is sent; each one that passed the checks is recorded here as
    /// `METHOD url`, and fails as if the network were down.
    #[cfg(any(test, feature = "test-support"))]
    offline: Option<Recorded>,
    /// Tests only: the answers an offline client gives a `get` (`web.read`), by address.
    #[cfg(any(test, feature = "test-support"))]
    canned: HashMap<String, Got>,
}

/// What a plain GET got: its status, headers (lowercase names) and body.
#[derive(Debug, Clone, Default)]
pub struct Got {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// The requests an offline client was asked to send.
#[cfg(any(test, feature = "test-support"))]
pub type Recorded = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

impl Client {
    pub fn new() -> Client {
        let inner = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Client {
            inner,
            max_bytes: MAX_BYTES,
            test_hosts: HashMap::new(),
            #[cfg(any(test, feature = "test-support"))]
            offline: None,
            #[cfg(any(test, feature = "test-support"))]
            canned: HashMap::new(),
        }
    }

    /// A client that sends nothing: the requests that pass the checks are recorded, and fail as
    /// if the network were down.
    #[cfg(any(test, feature = "test-support"))]
    pub fn offline() -> (Client, Recorded) {
        Client::canned(&[])
    }

    /// An offline client whose `get` answers these addresses (`status`, `content-type`, body);
    /// every request that passed the checks is recorded as `METHOD url`.
    #[cfg(any(test, feature = "test-support"))]
    pub fn canned(pages: &[(&str, u16, &str, &[u8])]) -> (Client, Recorded) {
        let recorded = Recorded::default();
        let client = Client {
            offline: Some(recorded.clone()),
            canned: pages
                .iter()
                .map(|(url, status, kind, body)| {
                    let headers = HashMap::from([("content-type".to_string(), kind.to_string())]);
                    let got = Got {
                        status: *status,
                        headers,
                        body: body.to_vec(),
                    };
                    (url.to_string(), got)
                })
                .collect(),
            ..Client::new()
        };
        (client, recorded)
    }

    /// A plain GET of an address already admitted: no redirect followed, nothing compressed
    /// asked for, `max` bytes at most, `timeout` in all.
    pub async fn get(&self, url: &Url, max: usize, timeout: Duration) -> Result<Got, HostError> {
        let host = url.host_str().unwrap_or("").to_string();
        #[cfg(any(test, feature = "test-support"))]
        if let Some(recorded) = &self.offline {
            recorded
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(format!("GET {url}"));
            return self.canned.get(url.as_str()).cloned().ok_or_else(|| {
                HostError::new(
                    ErrorCode::PluginError,
                    format!("couldn't reach {host}: offline (a test)"),
                )
            });
        }
        let target = self.target(url)?;
        let sent = self
            .inner
            .get(target)
            .header("Accept-Encoding", "identity")
            .header(
                "Accept",
                "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.1",
            )
            .timeout(timeout)
            .send();
        let res = sent.await.map_err(|e| failed(&host, &e))?;
        let status = res.status().as_u16();
        let headers: HashMap<String, String> = res
            .headers()
            .iter()
            .filter_map(|(n, v)| {
                Some((
                    n.as_str().to_ascii_lowercase(),
                    v.to_str().ok()?.to_string(),
                ))
            })
            .collect();
        let mut body = Vec::new();
        if (200..300).contains(&status) {
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| failed(&host, &e))?;
                if body.len() + chunk.len() > max {
                    return Err(HostError::new(
                        ErrorCode::Limit,
                        format!("{host} answered more than {} MB", max.div_ceil(1 << 20)),
                    ));
                }
                body.extend_from_slice(&chunk);
            }
        }
        Ok(Got {
            status,
            headers,
            body,
        })
    }

    /// A client that sends each `host` of `hosts` to its loopback base instead, with a shorter
    /// timeout (also for the tests in `tests/`, which run a real plugin against a fake server).
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_tests(hosts: &[(&str, String)], timeout: Duration) -> Client {
        let inner = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(timeout)
            .build()
            .unwrap();
        Client {
            inner,
            max_bytes: MAX_BYTES,
            test_hosts: hosts
                .iter()
                .map(|(h, base)| (h.to_string(), base.clone()))
                .collect(),
            offline: None,
            canned: HashMap::new(),
        }
    }

    pub async fn fetch(
        &self,
        p: &Granted,
        listed: &[String],
        url: &str,
        opts: &Value,
    ) -> Result<Value, HostError> {
        let url = allowed(p, listed, url)?;
        let method = opts["method"]
            .as_str()
            .unwrap_or("GET")
            .to_ascii_uppercase();
        if !METHODS.contains(&method.as_str()) {
            return Err(bad(format!("“{method}” isn't a method a plugin may use")));
        }
        let target = self.target(&url)?;
        let mut req = self.inner.request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| bad(e.to_string()))?,
            target,
        );
        for (name, value) in headers(&opts["headers"])? {
            req = req.header(name, value);
        }
        match &opts["body"] {
            Value::Null => {}
            Value::String(body) if !body.contains('\0') => req = req.body(body.clone()),
            _ => return Err(bad("a request's body is text without NUL characters")),
        }
        if !opts["save"].is_null() {
            return Err(super::unsupported("http.fetch's save"));
        }
        let host = url.host_str().unwrap_or("").to_string();
        #[cfg(any(test, feature = "test-support"))]
        if let Some(recorded) = &self.offline {
            let mut sent = recorded
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sent.push(format!("{method} {url}"));
            return Err(HostError::new(
                ErrorCode::PluginError,
                format!("couldn't reach {host}: offline (a test)"),
            ));
        }
        let res = req.send().await.map_err(|e| failed(&host, &e))?;
        let status = res.status().as_u16();
        let mut head = Map::new();
        for (name, value) in res.headers() {
            if let Ok(v) = value.to_str() {
                head.insert(name.as_str().to_string(), json!(v));
            }
        }
        let mut body = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| failed(&host, &e))?;
            if body.len() + chunk.len() > self.max_bytes {
                return Err(HostError::new(
                    ErrorCode::Limit,
                    format!("{host} answered more than {} MB", self.max_bytes >> 20),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(json!({
            "status": status,
            "headers": head,
            "body": String::from_utf8_lossy(&body),
        }))
    }

    /// Where the request goes: the address itself, or in tests its loopback stand-in.
    fn target(&self, url: &Url) -> Result<Url, HostError> {
        let Some(base) = url.host_str().and_then(|h| self.test_hosts.get(h)) else {
            return Ok(url.clone());
        };
        let mut target = Url::parse(base).map_err(|e| bad(e.to_string()))?;
        target.set_path(url.path());
        target.set_query(url.query());
        Ok(target)
    }
}

impl Default for Client {
    fn default() -> Client {
        Client::new()
    }
}

/// The address, if the plugin may reach it.
pub fn allowed(p: &Granted, listed: &[String], url: &str) -> Result<Url, HostError> {
    if url.contains(['\0', '\r', '\n']) {
        return Err(bad("an address has no control characters"));
    }
    let parsed = Url::parse(url).map_err(|_| bad(format!("“{url}” isn't an address")))?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    // Echo's words, which plugins match (`/may reach only/`).
    let refused = || {
        let hosts = p.words("network", "hosts");
        let settings = p.words("network", "hosts_from");
        permission(format!(
            "{} may reach only the hosts its manifest names ({}) and the addresses you list in its settings ({}), not {url}",
            p.id,
            if hosts.is_empty() { "none".to_string() } else { hosts.join(", ") },
            if settings.is_empty() { "none".to_string() } else { settings.join(", ") },
        ))
    };
    if host.is_empty() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(refused());
    }
    let named = parsed.scheme() == "https"
        && parsed.port().is_none()
        && p.words("network", "hosts")
            .iter()
            .any(|h| h.eq_ignore_ascii_case(&host));
    if named {
        return Ok(parsed);
    }
    let user_listed = !p.words("network", "hosts_from").is_empty()
        && listed.iter().any(|a| listed_matches(a, &parsed));
    let plain_ok = parsed.scheme() == "https" || (parsed.scheme() == "http" && local(&parsed));
    if user_listed && plain_ok {
        return Ok(parsed);
    }
    Err(refused())
}

/// An address the user listed (`host`, `host:port` or a URL) names this URL's host and port.
fn listed_matches(listed: &str, url: &Url) -> bool {
    let with_scheme = if listed.contains("://") {
        listed.to_string()
    } else {
        format!("{}://{listed}", url.scheme())
    };
    Url::parse(&with_scheme).is_ok_and(|l| {
        l.host_str()
            .is_some_and(|h| url.host_str().is_some_and(|u| h.eq_ignore_ascii_case(u)))
            && l.port_or_known_default() == url.port_or_known_default()
            && l.scheme() == url.scheme()
    })
}

/// Inside the user's own network: loopback, a private or link-local address, or `.local`.
fn local(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        // Loopback, unique local (fc00::/7) or link-local (fe80::/10).
        Some(url::Host::Ipv6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".local"),
        None => false,
    }
}

fn headers(v: &Value) -> Result<Vec<(String, String)>, HostError> {
    let Some(map) = v.as_object() else {
        return if v.is_null() {
            Ok(Vec::new())
        } else {
            Err(bad("headers are an object of names and text"))
        };
    };
    map.iter()
        .map(|(name, value)| {
            let token = !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
            let value = value.as_str().filter(|v| !v.contains(['\0', '\r', '\n']));
            match (token, value) {
                (true, Some(v)) => Ok((name.clone(), v.to_string())),
                _ => Err(bad(format!("the header “{name}” can't be sent"))),
            }
        })
        .collect()
}

fn failed(host: &str, e: &reqwest::Error) -> HostError {
    if e.is_timeout() {
        return HostError::new(
            ErrorCode::Timeout,
            format!("{host} didn't answer within 60 s"),
        );
    }
    HostError::new(
        ErrorCode::PluginError,
        format!("couldn't reach {host}: {e}"),
    )
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    /// A one-request-at-a-time HTTP server on loopback; each request is answered by `answer`
    /// with its request line. Runs until the test ends.
    fn serve(answer: fn(&str) -> Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = request.lines().next().unwrap_or("").to_string();
                let _ = stream.write_all(&answer(&line));
            }
        });
        base
    }

    fn response(status: &str, extra: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn answer(line: &str) -> Vec<u8> {
        if line.contains("/redirect") {
            return response("302 Found", "Location: https://evil.example.com/\r\n", b"");
        }
        if line.contains("/huge") {
            return response("200 OK", "", &vec![b'x'; 11 * 1024 * 1024]);
        }
        if line.contains("/slow") {
            std::thread::sleep(Duration::from_secs(3));
        }
        response("200 OK", "X-Seen: yes\r\n", line.as_bytes())
    }

    #[tokio::test]
    async fn an_offline_client_records_what_passed_the_checks_and_sends_nothing() {
        let (client, sent) = Client::offline();
        let env = Env::with(None, client);
        env.plugin(
            "net",
            json!({"network": {"hosts": ["api.example.com"]}}),
            json!([]),
        );
        let fetch = |url: &'static str| {
            env.call_async("net", "http.fetch", json!([url, {"method": "POST"}]))
        };
        let offline = fetch("https://api.example.com/graphql").await.unwrap_err();
        assert_eq!(offline.code, ErrorCode::PluginError);
        assert!(offline.message.contains("offline"), "{offline}");
        let refused = fetch("https://evil.example.com/").await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::Permission);
        assert!(
            refused
                .message
                .contains("may reach only the hosts its manifest names"),
            "{refused}"
        );
        assert_eq!(
            *sent.lock().unwrap(),
            ["POST https://api.example.com/graphql"]
        );
    }

    #[tokio::test]
    async fn http_blocks_non_allowlisted_host_redirect_and_http_scheme() {
        let base = serve(answer);
        let client = Client::for_tests(&[("api.example.com", base)], Duration::from_secs(2));
        let env = Env::with(None, client);
        env.plugin(
            "net",
            json!({"network": {"hosts": ["api.example.com"]}}),
            json!([]),
        );
        env.plugin("offline", json!({}), json!([]));
        let fetch = |id: &'static str, url: &'static str, opts: Value| {
            let env = &env;
            async move { env.call_async(id, "http.fetch", json!([url, opts])).await }
        };
        let ok = fetch(
            "net",
            "https://api.example.com/hello?x=1",
            json!({"method": "POST", "headers": {"Content-Type": "text/plain"}, "body": "hi"}),
        )
        .await
        .unwrap();
        assert_eq!(ok["status"], 200);
        assert_eq!(ok["body"], "POST /hello?x=1 HTTP/1.1");
        assert_eq!(ok["headers"]["x-seen"], "yes");

        // A redirect is answered as it is, never followed (the next host isn't allowed anyway).
        let r = fetch("net", "https://api.example.com/redirect", json!({}))
            .await
            .unwrap();
        assert_eq!(r["status"], 302);
        assert_eq!(r["headers"]["location"], "https://evil.example.com/");

        // Refused before anything is sent.
        for url in [
            "http://api.example.com/hello",
            "https://evil.example.com/",
            "https://api.example.com:8443/",
            "https://user:pw@api.example.com/",
            "https://api.example.com.evil.com/",
            "file:///etc/hosts",
            "ftp://api.example.com/",
        ] {
            let e = env
                .call_async("net", "http.fetch", json!([url, {}]))
                .await
                .unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission, "{url}: {e}");
        }
        let e = fetch("offline", "https://api.example.com/hello", json!({}))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        for opts in [
            json!({"method": "TRACE"}),
            json!({"headers": {"X-Bad": "a\r\nInjected: 1"}}),
            json!({"headers": {"Bad Name": "x"}}),
            json!({"body": "a\u{0}b"}),
        ] {
            let e = fetch("net", "https://api.example.com/x", opts.clone())
                .await
                .unwrap_err();
            assert_eq!(e.code, ErrorCode::PluginError, "{opts}: {e}");
        }
        // 10 MB at most, and the request's time is bounded.
        let e = fetch("net", "https://api.example.com/huge", json!({}))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Limit, "{e}");
        let e = fetch("net", "https://api.example.com/slow", json!({}))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Timeout, "{e}");
    }

    #[test]
    fn user_listed_addresses_allow_plain_http_only_inside_the_network() {
        let env = Env::new();
        let p = env.plugin(
            "home",
            json!({"network": {"hosts_from": ["server"]}}),
            json!([{"key": "server", "label": "Server", "type": "string"}]),
        );
        let listed = vec![
            "192.168.1.10:8080".to_string(),
            "nas.example.org".to_string(),
        ];
        assert!(allowed(&p, &listed, "http://192.168.1.10:8080/api").is_ok());
        assert!(allowed(&p, &listed, "https://nas.example.org/x").is_ok());
        // Not listed, another port, or plain HTTP outside the user's network.
        assert!(allowed(&p, &listed, "http://192.168.1.11:8080/").is_err());
        assert!(allowed(&p, &listed, "http://192.168.1.10/").is_err());
        assert!(allowed(&p, &listed, "http://nas.example.org/x").is_err());
        assert!(allowed(&p, &[], "http://192.168.1.10:8080/api").is_err());
    }
}
