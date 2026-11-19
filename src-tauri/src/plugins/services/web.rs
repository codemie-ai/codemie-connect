//! `ctx.web.read(url, {max, timeout, images})` and `ctx.http.askAddress()` (Echo 0.10's plugin API,
//! "Reading a web page"). A page is read only where the plugin may reach (`http::allowed`: a host
//! its sheet named, or an address the user listed in its settings), or at the one address the
//! user typed in Connect's own box (`askAddress`, good for one read within 10 minutes). Everything
//! else is refused with Echo's words ("… may reach only …"), which plugins match to ask instead.
//!
//! The read is a plain GET: no redirect followed, nothing compressed, HTML only, 5 MB and 30 s at
//! most. `web_page::read_html` turns it into Markdown. With `images: 'save'`, the page's pictures
//! from its own site are saved in the plugin's store (`cache/web/`), 50 of them and 10 MB each at
//! most, 50 MB in all, each as a file handle of the plugin's (`saved: {file, name, size, type}`)
//! the plugin then copies where it wants (`fs.copyIn`); a picture not saved says why (`error`).
use super::{at, bad, lock, permission, settings, text, web_page, Granted, Services};
use crate::plugins::host::HostError;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use url::Url;

const PAGE_MAX: usize = 5 << 20;
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);
const MARKDOWN_MAX: usize = 2 << 20;
const IMAGES_MAX: usize = 50;
const IMAGE_MAX: usize = 10 << 20;
const IMAGES_TOTAL: usize = 50 << 20;
/// An address the user typed is good for one read this long.
const ASKED_FOR: Duration = Duration::from_secs(600);
/// The longest address the box takes.
const ADDRESS_MAX: usize = 2000;

/// Addresses the user typed for plugins (`askAddress`), each good for one read.
#[derive(Default)]
pub struct Asked(Vec<(String, String, Instant)>);

impl Asked {
    fn take(&mut self, plugin: &str, url: &str) -> bool {
        self.0.retain(|(_, _, at)| at.elapsed() < ASKED_FOR);
        match self.0.iter().position(|(p, u, _)| p == plugin && u == url) {
            Some(i) => {
                self.0.remove(i);
                true
            }
            None => false,
        }
    }
}

/// An address the user may type: `http(s)://<host>…`, no user name or password, one line.
pub fn typed_address(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() || t.len() > ADDRESS_MAX || t.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(t).ok()?;
    let ok = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|h| !h.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && !t.contains('@');
    ok.then(|| url.to_string())
}

/// `http.askAddress()`: Connect's own box asks the user for one page's address; `null` when they
/// cancel. Needs `uses.network.ask`.
pub async fn ask_address(s: &Services, p: &Granted) -> Result<Value, HostError> {
    if !p.flag("network", "ask") {
        return Err(permission(format!(
            "{} didn't ask to read a page at an address you type when it was installed (uses.network.ask)",
            p.id
        )));
    }
    let answer = s.outside.picker.ask_address(p.name.clone()).await;
    let Some(url) = answer.as_deref().and_then(typed_address) else {
        return Ok(Value::Null);
    };
    let mut asked = lock(&s.asked);
    asked.0.push((p.id.clone(), url.clone(), Instant::now()));
    Ok(json!(url))
}

/// The address, if the plugin may read it: one it may reach, else one the user typed for it.
fn admitted(s: &Services, p: &Granted, url: &str) -> Result<Url, HostError> {
    let listed = settings::listed_addresses(s, p);
    match super::http::allowed(p, &listed, url) {
        Ok(u) => Ok(u),
        Err(refused) => {
            let typed = typed_address(url).filter(|u| lock(&s.asked).take(&p.id, u));
            typed.and_then(|u| Url::parse(&u).ok()).ok_or(refused)
        }
    }
}

pub async fn read(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    let url = admitted(s, p, text(args, 0, "a page's address")?)?;
    let o = at(args, 1);
    let max = o["max"]
        .as_u64()
        .filter(|m| *m > 0)
        .map_or(PAGE_MAX, |m| (m as usize).min(PAGE_MAX));
    let timeout = o["timeout"]
        .as_u64()
        .filter(|t| *t > 0)
        .map_or(PAGE_TIMEOUT, |t| Duration::from_secs(t).min(PAGE_TIMEOUT));
    let host = url.host_str().unwrap_or("").to_string();
    let got = s.outside.http.get(&url, max, timeout).await?;
    if (300..400).contains(&got.status) {
        let to = got.headers.get("location").cloned().unwrap_or_default();
        return Err(bad(format!(
            "{url} moved to {to}: Connect doesn't follow a page elsewhere; add that address instead"
        )));
    }
    if !(200..300).contains(&got.status) {
        return Err(bad(format!("{host} answered {}", got.status)));
    }
    let kind = got.headers.get("content-type").cloned().unwrap_or_default();
    let kind_l = kind.to_ascii_lowercase();
    if !(kind_l.starts_with("text/html") || kind_l.starts_with("application/xhtml+xml")) {
        return Err(bad(format!(
            "{url} isn't a web page ({}): add the file instead",
            if kind.is_empty() { "no type" } else { &kind }
        )));
    }
    if got
        .headers
        .get("content-encoding")
        .is_some_and(|e| !e.eq_ignore_ascii_case("identity"))
    {
        return Err(bad(format!(
            "{host} sent the page compressed, which Connect doesn't read"
        )));
    }
    let bytes = got.body.len();
    let html = String::from_utf8_lossy(&got.body).into_owned();
    let page_url = url.to_string();
    let page = tauri::async_runtime::spawn_blocking(move || {
        web_page::read_html(&page_url, &html, MARKDOWN_MAX)
    })
    .await
    .map_err(|e| bad(e.to_string()))?;
    let mut images: Vec<Value> = page
        .images
        .iter()
        .map(|im| {
            json!({"src": im.src, "alt": im.alt, "caption": im.caption, "width": im.width, "height": im.height})
        })
        .collect();
    if o["images"] == "save" {
        save_images(s, p, &url, &mut images).await;
    }
    Ok(json!({
        "url": url.to_string(),
        "title": page.title,
        "markdown": page.markdown,
        "links": page.links.iter().map(|(t, h)| json!({"text": t, "href": h})).collect::<Vec<_>>(),
        "images": images,
        "lang": page.lang,
        "byline": page.byline,
        "published": page.published,
        "description": page.description,
        "source": page.source,
        "needs_js": page.needs_js,
        "truncated": page.truncated,
        "bytes": bytes,
    }))
}

/// A picture's file name and type by what its site said it is.
fn picture_kind(kind: &str) -> Option<&'static str> {
    match kind
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Saves the page's pictures from its own site into the plugin's store, each as a handle.
async fn save_images(s: &Services, p: &Granted, page: &Url, images: &mut [Value]) {
    let folder = super::store::root(s, &p.id)
        .join("cache/web")
        .join(uuid::Uuid::new_v4().simple().to_string());
    let mut total = 0usize;
    for (n, im) in images.iter_mut().enumerate() {
        if n >= IMAGES_MAX {
            im["error"] = json!("Connect saves 50 pictures of a page at most");
            continue;
        }
        let Some(url) = im["src"].as_str().and_then(|u| Url::parse(u).ok()) else {
            im["error"] = json!("not an address Connect reads");
            continue;
        };
        if url.host_str() != page.host_str() || url.scheme() != page.scheme() {
            im["error"] = json!(format!(
                "not saved: it is on {}, not on the page's site",
                url.host_str().unwrap_or("another site")
            ));
            continue;
        }
        let got = match s.outside.http.get(&url, IMAGE_MAX, PAGE_TIMEOUT).await {
            Ok(g) if (200..300).contains(&g.status) => g,
            Ok(g) => {
                im["error"] = json!(format!("its site answered {}", g.status));
                continue;
            }
            Err(e) => {
                im["error"] = json!(e.message);
                continue;
            }
        };
        let kind = got.headers.get("content-type").cloned().unwrap_or_default();
        let Some(ext) = picture_kind(&kind) else {
            im["error"] = json!("Connect saves png, jpg, gif and webp pictures only");
            continue;
        };
        if total + got.body.len() > IMAGES_TOTAL {
            im["error"] = json!("Connect saves 50 MB of a page's pictures at most");
            continue;
        }
        total += got.body.len();
        let name = format!("{:02}.{ext}", n + 1);
        let path = folder.join(&name);
        let written =
            std::fs::create_dir_all(&folder).and_then(|_| std::fs::write(&path, &got.body));
        if let Err(e) = written {
            im["error"] = json!(format!("couldn't keep it: {e}"));
            continue;
        }
        match lock(&s.files).make(&p.id, path) {
            Ok(h) => {
                im["saved"] =
                    json!({"file": h["file"], "name": name, "size": got.body.len(), "type": kind});
            }
            Err(e) => im["error"] = json!(e.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::Client;
    use super::super::testing::Env;
    use super::*;
    use crate::plugins::host::ErrorCode;

    const PAGE: &str = "<html lang=en><head><title>Atlas launch</title></head><body><article>\
        <h1>Atlas launches in May</h1><p>The team ships the beta.</p>\
        <img src=\"/img/chart.png\" alt=\"Chart\" width=\"400\" height=\"300\">\
        <img src=\"https://cdn.example.net/x.png\" alt=\"Elsewhere\" width=\"400\" height=\"300\">\
        </article></body></html>";

    fn env_with(pages: &[(&str, u16, &str, &[u8])]) -> (Env, super::super::http::Recorded) {
        let (client, sent) = Client::canned(pages);
        let env = Env::with(None, client);
        env.plugin(
            "kn",
            json!({"network": {"hosts_from": ["web_sites"], "ask": true}}),
            json!([{"key": "web_sites", "label": "Sites", "type": "string"}]),
        );
        (env, sent)
    }

    #[tokio::test]
    async fn a_page_off_the_listed_sites_is_refused_in_echos_words_until_the_user_types_it() {
        let (env, sent) = env_with(&[
            (
                "https://news.example.com/atlas",
                200,
                "text/html; charset=utf-8",
                PAGE.as_bytes(),
            ),
            (
                "https://news.example.com/img/chart.png",
                200,
                "image/png",
                b"\x89PNG",
            ),
        ]);
        let read = |args: Value| env.call_async("kn", "web.read", args);
        let e = read(json!(["https://news.example.com/atlas"]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert!(e.message.contains("may reach only"), "{e}");
        assert!(sent.lock().unwrap().is_empty(), "nothing fetched");

        // The user types it in Connect's box: one read of that page, then it's refused again.
        *env.picker.2.lock().unwrap() = Some("  https://news.example.com/atlas ".into());
        let typed = env
            .call_async("kn", "http.askAddress", json!([]))
            .await
            .unwrap();
        assert_eq!(typed, json!("https://news.example.com/atlas"));
        let page = read(json!(["https://news.example.com/atlas", {"images": "save"}]))
            .await
            .unwrap();
        assert_eq!(page["title"], "Atlas launches in May");
        assert!(page["markdown"]
            .as_str()
            .unwrap()
            .contains("The team ships the beta."));
        assert_eq!(page["lang"], "en");
        assert_eq!(page["bytes"], PAGE.len());
        let images = page["images"].as_array().unwrap();
        assert_eq!(images[0]["saved"]["name"], "01.png", "{page}");
        assert_eq!(images[0]["saved"]["size"], 4);
        assert!(images[1]["error"]
            .as_str()
            .unwrap()
            .contains("not on the page's site"));
        // The saved picture is a handle of the plugin's, to copy where it wants.
        let file = images[0]["saved"]["file"].as_str().unwrap();
        assert!(lock(&env.services.files).path_of("kn", file).is_ok());
        assert!(read(json!(["https://news.example.com/atlas"]))
            .await
            .unwrap_err()
            .message
            .contains("may reach only"));
        // A cancelled box, or an address that isn't one, gives nothing.
        assert_eq!(
            env.call_async("kn", "http.askAddress", json!([]))
                .await
                .unwrap(),
            Value::Null
        );
        *env.picker.2.lock().unwrap() = Some("https://user@news.example.com/".into());
        assert_eq!(
            env.call_async("kn", "http.askAddress", json!([]))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            *sent.lock().unwrap(),
            [
                "GET https://news.example.com/atlas",
                "GET https://news.example.com/img/chart.png"
            ]
        );
    }

    #[tokio::test]
    async fn listed_sites_are_read_but_not_redirects_or_files() {
        let (env, _) = env_with(&[
            (
                "https://wiki.acme.example/a",
                200,
                "text/html",
                PAGE.as_bytes(),
            ),
            ("https://wiki.acme.example/moved", 301, "text/html", b""),
            (
                "https://wiki.acme.example/deck.pdf",
                200,
                "application/pdf",
                b"%PDF",
            ),
            ("https://wiki.acme.example/gone", 404, "text/html", b""),
        ]);
        // The sites the user listed in the plugin's settings (Settings → Plugins sets them).
        super::super::write_json(
            &env.services.data_of("kn").join("settings.json"),
            &json!({"web_sites": "https://wiki.acme.example"}),
        )
        .unwrap();
        let read = |u: &str| env.call_async("kn", "web.read", json!([u]));
        assert_eq!(
            read("https://wiki.acme.example/a").await.unwrap()["title"],
            "Atlas launches in May"
        );
        assert!(read("https://wiki.acme.example/moved")
            .await
            .unwrap_err()
            .message
            .contains("doesn't follow"));
        assert!(read("https://wiki.acme.example/deck.pdf")
            .await
            .unwrap_err()
            .message
            .contains("isn't a web page"));
        assert!(read("https://wiki.acme.example/gone")
            .await
            .unwrap_err()
            .message
            .contains("answered 404"));
    }

    #[test]
    fn typed_addresses_are_plain_web_addresses() {
        assert_eq!(
            typed_address(" https://a.example/x ").as_deref(),
            Some("https://a.example/x")
        );
        for bad in [
            "",
            "ftp://a.example/",
            "https://u:p@a.example/",
            "javascript:alert(1)",
            "a.example",
            "https://a.example/\u{7}x",
        ] {
            assert_eq!(typed_address(bad), None, "{bad}");
        }
    }
}
