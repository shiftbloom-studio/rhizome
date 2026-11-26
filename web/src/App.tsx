// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { DetailPanel } from "./DetailPanel";
import { MemoryGraph, TRUST_COLOR } from "./MemoryGraph";
import type { Graph, Me, SearchResult } from "./types";
import { Bloom } from "./Bloom";

const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [scopes, setScopes] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      if (m.linked) setGraph(await api.graph(scopes ?? undefined));
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [scopes]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInput.current?.focus();
      }
      if (e.key === "Escape") {
        setSelected(null);
        setResult(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) {
      setResult(null);
      return;
    }
    setSearching(true);
    try {
      setResult(await api.search(q, scopes ?? undefined));
      setSelected(null);
    } catch (err) {
      setNotice(String((err as Error).message));
    } finally {
      setSearching(false);
    }
  };

  const visible = useMemo(() => {
    if (!graph || !reviewOnly) return graph;
    const keep = new Set(graph.nodes.filter((n) => n.status === "disputed").map((n) => n.id));
    for (const e of graph.edges) {
      if (e.kind !== "contradicts") continue;
      if (keep.has(e.source)) keep.add(e.target);
      if (keep.has(e.target)) keep.add(e.source);
    }
    return { ...graph, nodes: graph.nodes.filter((n) => keep.has(n.id)), edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
  }, [graph, reviewOnly]);

  const highlight = useMemo(() => {
    if (!result || !graph) return null;
    const ids = new Set(graph.nodes.map((n) => n.id));
    const hits = new Set<string>();
    for (const i of result.items) {
      if (ids.has(i.id)) hits.add(i.id);
      else if (i.episodeId && ids.has(i.episodeId)) hits.add(i.episodeId);
    }
    return hits;
  }, [result, graph]);

  const toggleScope = (s: string) => {
    const all = me?.scopes ?? [];
    const current = scopes ?? all;
    const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
    setScopes(next.length === all.length ? null : next);
  };

  const reflect = async () => {
    try {
      await api.reflect();
      setNotice("Reflection started. New links, entities and summaries show up in a minute or two.");
      // Pick up the new edges without a manual reload.
      for (const ms of [45_000, 120_000]) setTimeout(() => void load(), ms);
    } catch (err) {
      setNotice(String((err as Error).message));
    }
  };

  if (error) {
    return (
      <div className="center-message">
        <Wordmark />
        <p>The explorer could not load: {error}</p>
        <button className="btn" onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }
  if (!me) return <div className="center-message"><Wordmark /><p className="label">loading memory</p></div>;
  if (!me.linked) {
    return (
      <div className="center-message">
        <Wordmark />
        <p>You're signed in as <strong>{me.email}</strong>, but no memory is linked to this address yet.</p>
        <p className="muted">An administrator links it with <code>PATCH /v1/admin/users/&lt;id&gt;</code> and your email address.</p>
        <Footer signOut={me.signOut} />
      </div>
    );
  }

  const stats = me.stats;
  const empty = graph && graph.nodes.length === 0;

  return (
    <div className="app">
      <div className="stage">
        {visible && visible.nodes.length > 0 && (
          <MemoryGraph graph={visible} highlight={highlight} selected={selected} onSelect={setSelected} reducedMotion={reducedMotion} rightPanel={Boolean(selected || result)} />
        )}
        {empty && (
          <div className="empty">
            <p className="label">nothing remembered yet</p>
            <p>Give an agent an API key and let it write its first episode, or note something about yourself on the left.</p>
          </div>
        )}
      </div>

      <header className="bar">
        <Wordmark />
        <form className="search" onSubmit={search} role="search">
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask your memory, e.g. which license do my projects use?"
            aria-label="Search memory"
          />
          <kbd>⌘K</kbd>
          <button className="btn" type="submit" disabled={searching}>{searching ? "Searching" : "Search"}</button>
        </form>
        <div className="who">
          <button className="btn ghost" onClick={reflect} title="Merge duplicates, link related notes, tag the projects and tools they name, and rewrite the summaries now">Reflect now</button>
          <span className="label">{me.email}</span>
        </div>
      </header>

      <aside className="side">
        <section>
          <h2 className="label">scopes</h2>
          <div className="chips">
            {(me.scopes ?? []).map((s) => (
              <button key={s} className={`chip${!scopes || scopes.includes(s) ? " on" : ""}`} onClick={() => toggleScope(s)}>
                {s}
              </button>
            ))}
          </div>
        </section>
        {stats && stats.disputed > 0 && (
          <section>
            <button className={`review${reviewOnly ? " on" : ""}`} onClick={() => setReviewOnly(!reviewOnly)}>
              <span className="seed" /> {stats.disputed} {stats.disputed === 1 ? "memory contradicts" : "memories contradict"} another one
              <span className="muted">{reviewOnly ? "Show everything" : "Review"}</span>
            </button>
          </section>
        )}
        <section>
          <h2 className="label">legend</h2>
          <ul className="legend">
            <li><i style={{ background: TRUST_COLOR.user_explicit }} />you said it</li>
            <li><i style={{ background: TRUST_COLOR.user_confirmed }} />you confirmed it</li>
            <li><i style={{ background: TRUST_COLOR.agent_inference }} />an agent concluded it</li>
            <li><i className="diamond" />conversation</li>
            <li><i style={{ background: "#1A1216" }} />person, project or tool</li>
          </ul>
        </section>
        {stats && (
          <section>
            <h2 className="label">memory</h2>
            <dl className="stats">
              <dt>notes</dt><dd>{stats.notes}</dd>
              <dt>conversations</dt><dd>{stats.episodes}</dd>
              <dt>entities</dt><dd>{stats.entities}</dd>
              <dt>links</dt><dd>{stats.links}</dd>
              <dt>replaced</dt><dd>{stats.superseded}</dd>
              <dt>last reflection</dt><dd>{stats.lastReflection ? new Date(Number(stats.lastReflection)).toLocaleDateString() : "never"}</dd>
            </dl>
          </section>
        )}
        <Remember scopes={me.scopes ?? []} onSaved={() => { setNotice("Saved. It shows up in the graph after a short moment."); setTimeout(load, 2500); }} />
        <Footer signOut={me.signOut} />
      </aside>

      {result && !selected && (
        <section className="results" aria-live="polite">
          <header>
            <span className="label">
              {result.items.length} results · {result.totalMs} ms · vector {result.sources.vector ?? 0} · text {result.sources.fts ?? 0}
            </span>
            <button className="close" onClick={() => setResult(null)} aria-label="Close results">×</button>
          </header>
          {result.items.length === 0 && <p className="muted">Nothing matches. Try other words, or include more scopes.</p>}
          <ol>
            {result.items.map((i) => (
              <li key={i.id}>
                <button onClick={() => setSelected(highlight?.has(i.id) ? i.id : (i.episodeId ?? i.id))}>
                  <span className="score" style={{ width: `${Math.round((i.score ?? 0) * 100)}%` }} />
                  <span className="meta label">{i.kind === "note" ? i.noteKind : "conversation"} · {i.scope} · {(i.score ?? 0).toFixed(2)}</span>
                  <span className="text">{i.content}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {selected && (
        <DetailPanel
          id={selected}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          onChanged={(msg) => {
            setNotice(msg);
            void load();
          }}
        />
      )}

      {graph?.truncated && <p className="truncated label">showing the {graph.nodes.filter((n) => n.type === "note").length} most important notes</p>}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}

function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="rhizome">
      <Bloom size={30} />
      <span>rhizome<i>.</i></span>
    </a>
  );
}

function Footer({ signOut }: { signOut?: string | null }) {
  const leave = async () => {
    await fetch(signOut!, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    window.location.assign("/auth/login");
  };
  return (
    <footer className="foot">
      <a href="/privacy">Privacy</a> · <a href="/imprint">Imprint</a> · <a href="https://github.com/shiftbloom-studio/rhizome">AGPL-3.0</a>
      {signOut && (
        <>
          {" · "}
          <button type="button" className="link" onClick={leave}>Sign out</button>
        </>
      )}
    </footer>
  );
}

function Remember({ scopes, onSaved }: { scopes: string[]; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState("profile");
  const [kind, setKind] = useState("preference");
  const [busy, setBusy] = useState(false);
  const options = scopes.includes("profile") ? scopes : ["profile", ...scopes];
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.remember(text.trim(), scope, kind);
      setText("");
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2 className="label">remember</h2>
      <form className="remember" onSubmit={save}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Something every agent should know about you" maxLength={8000} />
        <div className="row">
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
            {options.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            {["preference", "decision", "fact", "learning", "note"].map((k) => <option key={k}>{k}</option>)}
          </select>
          <button className="btn" disabled={busy || !text.trim()}>Save note</button>
        </div>
      </form>
    </section>
  );
}
