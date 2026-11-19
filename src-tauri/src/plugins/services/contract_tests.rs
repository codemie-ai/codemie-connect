//! Echo 0.10's plugin API as Knowledge holds Connect to it (plan Task 8): every error text the
//! plugin matches, run through the plugin's own regular expression in QuickJS against the message a
//! plugin gets from Connect (`code: message`), and the keys and types of each answer the plugin's
//! test fakes (`tests/helpers/fake-ctx.mjs` in echo-plugins) give, against Connect's real answer.
use super::testing::{shape, Env};
use super::{claude, http, skills, vault_git};
use crate::ai::fake::FakeRunner;
use crate::plugins::host::HostError;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Whether the plugin's regular expression `re` (JavaScript, as written in the plugin) matches
/// `text`.
fn js_test(re: &str, text: &str) -> bool {
    let rt = rquickjs::Runtime::new().unwrap();
    let ctx = rquickjs::Context::full(&rt).unwrap();
    ctx.with(|c| {
        c.globals().set("text", text).unwrap();
        c.eval::<bool, _>(format!("{re}.test(text)")).unwrap()
    })
}

/// `e` as the plugin reads it (`e.message`) matches each of `res`.
fn matches(e: &HostError, res: &[&str]) {
    let message = e.to_string();
    for re in res {
        assert!(js_test(re, &message), "{re} doesn't match “{message}”");
    }
}

/// A plugin `kn` that may write the folder it was given, `Vault` (`notes/a.md`, `bin.md` that
/// isn't UTF-8, `.git/config`), and that folder as Connect granted it.
async fn vault() -> (Env, String) {
    let env = Env::new();
    env.plugin(
        "kn",
        json!({"folders": {"write": true}, "skills": {}}),
        json!([]),
    );
    let v = env.dir.path().join("Vault");
    for (p, t) in [
        ("notes/a.md", &b"# Atlas\n\nThe beta ships in May.\n"[..]),
        ("bin.md", &[0xff, 0xfe, 0x41][..]),
        (".git/config", &b"x"[..]),
    ] {
        let f = v.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, t).unwrap();
    }
    env.picker.next(&v);
    let root = env
        .call_async("kn", "system.pickFolder", json!(["A vault"]))
        .await
        .unwrap();
    (env, root.as_str().unwrap().to_string())
}

#[tokio::test]
async fn connects_error_texts_match_the_plugins_regular_expressions() {
    let (env, root) = vault().await;
    let sync = |name: &str, args: Value| env.call("kn", name, args).unwrap_err();
    // A file there already (`createNew`, and `copyIn`, which never writes over a file).
    let e = sync(
        "fs.write",
        json!([root, "notes/a.md", "x", {"createNew": true}]),
    );
    matches(&e, &["/is there already/", "/there already/"]);
    let src = env.dir.path().join("Deck.pdf");
    std::fs::write(&src, "%PDF").unwrap();
    env.picker.next_files(&[&src]);
    let picked = env
        .call_async("kn", "system.pickFiles", json!(["A file"]))
        .await
        .unwrap();
    let e = env
        .call_async("kn", "fs.copyIn", json!([picked[0], root, "notes/a.md"]))
        .await
        .unwrap_err();
    matches(&e, &["/is there already/"]);
    // A file changed since it was read.
    let e = sync(
        "fs.write",
        json!([root, "notes/a.md", "x", {"ifSha": "0".repeat(64)}]),
    );
    matches(
        &e,
        &[
            "/changed since you read it/",
            "/changed since( you read it)?/",
            "/changed since/",
        ],
    );
    // Bytes that aren't UTF-8, read strictly.
    let e = sync("fs.read", json!([root, "bin.md", {"strict": true}]));
    matches(&e, &["/not UTF-8/i", "/UTF-8/i"]);
    // A hidden file, and a hidden folder offered by the picker.
    let e = sync("fs.write", json!([root, ".git/config", "x"]));
    matches(&e, &["/hidden/"]);
    let hidden = env.dir.path().join(".config/vault");
    std::fs::create_dir_all(&hidden).unwrap();
    env.picker.next(&hidden);
    let e = env
        .call_async("kn", "system.pickFolder", json!(["A vault"]))
        .await
        .unwrap_err();
    matches(&e, &["/hidden/"]);
    // No git on the PATH.
    let empty = env.dir.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let e = vault_git::locate(empty.as_os_str(), &empty).unwrap_err();
    matches(&e, &["/isn't installed/"]);
    // An address the manifest doesn't name.
    let p = env.services.granted("kn").unwrap();
    let e = http::allowed(&p, &[], "https://elsewhere.example/x").unwrap_err();
    matches(&e, &["/may reach only/"]);
    // A run under a key that is running already.
    let token = CancellationToken::new();
    let _held = claude::claim(&env.services, "kn", "lint-v", &token).unwrap();
    let e = claude::claim(&env.services, "kn", "LINT-V", &token)
        .err()
        .unwrap();
    matches(&e, &["/the run's key is busy/"]);
    // A skill the plugin didn't add (Knowledge's KN_SKILL_GONE).
    let home = env.dir.path().join("home");
    let e = skills::remove(&env.services, &p, "twin-vault", &home).unwrap_err();
    matches(&e, &["/isn't a skill .* added/"]);
}

#[tokio::test]
async fn microsoft_365_signed_out_says_it_isnt_connected() {
    let dir = tempfile::tempdir().unwrap();
    let core = crate::workspace::test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
    let env = Env::with(Some(core), http::Client::new());
    env.plugin(
        "kn",
        json!({"m365": {"read": ["mail", "chats"]}}),
        json!([]),
    );
    for (name, args) in [
        ("m365.search", json!(["atlas"])),
        ("m365.mailThread", json!(["g-1"])),
        ("m365.chat", json!(["19:ops"])),
    ] {
        let e = env.call_async("kn", name, args).await.unwrap_err();
        matches(&e, &["/isn't connected/"]);
    }
}

#[tokio::test]
async fn connects_answers_have_the_shapes_the_plugins_fakes_give() {
    let (env, root) = vault().await;
    let sync = |name: &str, args: Value| env.call("kn", name, args).unwrap();
    let call = |name: &'static str, args: Value| {
        let env = &env;
        async move { env.call_async("kn", name, args).await.unwrap() }
    };
    // ctx.fs
    assert_eq!(
        shape(&sync("fs.stat", json!([root, "notes/a.md", {"sha": true}]))),
        json!({"kind": "str", "size": "num", "mtime": "num", "real": "str", "sha": "str"})
    );
    assert_eq!(
        shape(&sync("fs.stat", json!([root, "notes"]))),
        json!({"kind": "str", "size": "num", "mtime": "num", "real": "str"})
    );
    assert_eq!(sync("fs.stat", json!([root, "nowhere.md"])), Value::Null);
    assert_eq!(
        shape(&sync("fs.list", json!([root, "notes"]))),
        json!([{"name": "str", "dir": "bool"}])
    );
    assert_eq!(
        shape(&call("fs.walk", json!([root, {"ext": ["md"], "sha": true}])).await),
        json!([{"path": "str", "size": "num", "mtime": "num", "sha": "str"}])
    );
    assert_eq!(
        shape(&call("fs.search", json!([root, "beta"])).await),
        json!([{"path": "str", "line": "num", "text": "str"}])
    );
    let src = env.dir.path().join("Deck.pdf");
    std::fs::write(&src, "%PDF").unwrap();
    env.picker.next_files(&[&src]);
    let picked = call("system.pickFiles", json!(["A file"])).await;
    assert_eq!(
        shape(&picked),
        json!([{"file": "str", "name": "str", "size": "num"}])
    );
    assert_eq!(
        shape(&call("fs.copyIn", json!([picked[0], root, "raw/Deck.pdf"])).await),
        json!({"path": "str", "size": "num"})
    );
    // ctx.store.walk and ctx.crypto.sha256
    sync("store.write", json!(["cache/a.json", "{}"]));
    assert_eq!(
        shape(&call("store.walk", json!(["cache", {"sha": true}])).await),
        json!([{"path": "str", "size": "num", "mtime": "num", "sha": "str"}])
    );
    assert_eq!(
        sync("crypto.sha256", json!(["abc"])),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // ctx.markdown.links with `detail`
    assert_eq!(
        shape(&sync(
            "markdown.links",
            json!(["See [[Ann Lee]] and ![[chart.png]].", {"detail": true}])
        )),
        json!({"links": ["str"], "images": ["str"], "entries": [{"dest": "str", "kind": "str", "embed": "bool"}]})
    );
    // ctx.git: a plain folder, a new repository, a commit, its status, log and a version.
    assert_eq!(
        call("git.info", json!([root])).await,
        json!({"repo": false})
    );
    assert_eq!(call("git.init", json!([root])).await, json!({"repo": true}));
    assert_eq!(
        shape(&call("git.info", json!([root])).await),
        json!({"repo": "bool", "branch": "str", "head": "null", "detached": "bool", "busy": "null", "subfolder": "bool"})
    );
    let commit = json!([root, {"paths": ["notes/a.md"], "message": "Add Atlas"}]);
    assert_eq!(
        shape(&call("git.commit", commit.clone()).await),
        json!({"rev": "str"})
    );
    assert_eq!(
        call("git.commit", commit).await,
        json!({"rev": null}),
        "nothing new"
    );
    sync("fs.write", json!([root, "notes/a.md", "# Atlas\n\nMay.\n"]));
    assert_eq!(
        shape(&call("git.status", json!([root, {"paths": ["notes"]}])).await),
        json!([{"path": "str", "code": "str"}])
    );
    let log = call("git.log", json!([root, {"path": "notes/a.md"}])).await;
    let keys: Vec<&String> = log[0].as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["author", "date", "echo", "email", "path", "rev", "subject"],
        "{log}"
    );
    assert_eq!(
        shape(&call("git.show", json!([root, "HEAD", "notes/a.md"])).await),
        json!({"text": "str", "size": "num", "truncated": "bool"})
    );
}
