// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { api } from "./api";
import { TRUST_COLOR } from "./MemoryGraph";
import type { Detail, Neighbour } from "./types";

const RELATION: Record<string, { out: string; in: string }> = {
  supersedes: { out: "replaces", in: "replaced by" },
  merged_into: { out: "merged into", in: "absorbed" },
  contradicts: { out: "contradicts", in: "contradicted by" },
  similar: { out: "similar to", in: "similar to" },
  derived_from: { out: "learned from", in: "taught" },
};

const TRUST_LABEL: Record<string, string> = {
  user_explicit: "you said it",
  user_confirmed: "you confirmed it",
  agent_inference: "an agent concluded it",
  tool: "from a tool",
};

const date = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function DetailPanel({ id, onClose, onSelect, onChanged }: { id: string; onClose: () => void; onSelect: (id: string) => void; onChanged: (msg: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    setConfirmForget(false);
    api.detail(id).then((d) => live && setDetail(d)).catch((e) => live && setError(String(e.message)));
    return () => {
      live = false;
    };
  }, [id]);

  const forget = async () => {
    await api.forget(id);
    onChanged("Forgotten everywhere, including its vectors and the raw conversation.");
    onClose();
  };
  const confirm = async () => {
    await api.confirm(id);
    onChanged("Confirmed. Agents now treat this as something you said.");
    setDetail(await api.detail(id));
  };

  return (
    <aside className="detail" aria-label="Details">
      <button className="close" onClick={onClose} aria-label="Close details">×</button>
      {error && <p className="muted">{error}</p>}
      {!detail && !error && <p className="label">loading</p>}
      {detail && (detail.type === "note" || detail.type === "chunk") && (
        <>
          <p className="label">{detail.type === "note" ? `${detail.item.noteKind} · ${detail.item.scope}` : `conversation excerpt · ${detail.item.scope}`}</p>
          <p className="content">{detail.item.content}</p>
          {detail.item.status !== "active" && (
            <p className={`status ${detail.item.status}`}>
              {detail.item.status === "disputed" && "This contradicts another memory. Confirm the one that is right."}
              {detail.item.status === "superseded" && "Replaced by a newer memory. Recall returns the newer one."}
              {detail.item.status === "archived" && "Archived after a year without use. Still stored, no longer recalled."}
            </p>
          )}
          <dl className="facts">
            <dt>source</dt>
            <dd><i className="dot" style={{ background: TRUST_COLOR[detail.item.trust] }} />{TRUST_LABEL[detail.item.trust] ?? detail.item.trust}</dd>
            <dt>written by</dt><dd>{detail.item.agent} · {detail.item.provider}{detail.item.origin === "extracted" ? " (extracted)" : detail.item.origin === "import" ? " (imported)" : ""}</dd>
            <dt>when</dt><dd>{date(detail.item.tEvent)}</dd>
            <dt>importance</dt><dd><span className="meter"><span style={{ width: `${Math.round(detail.item.importance * 100)}%` }} /></span>{detail.item.importance.toFixed(2)}</dd>
            <dt>confirmed</dt><dd>{detail.item.confirmations}×</dd>
            <dt>recalled</dt><dd>{detail.accessCount}×</dd>
          </dl>
          <Entities list={detail.entities} onSelect={onSelect} />
          <Neighbours list={detail.neighbours} onSelect={onSelect} />
          <div className="actions">
            {detail.type === "note" && (detail.item.trust !== "user_explicit" || detail.item.status === "disputed") && (
              <button className="btn" onClick={confirm}>Confirm</button>
            )}
            <ForgetButton armed={confirmForget} arm={() => setConfirmForget(true)} forget={forget} />
          </div>
        </>
      )}
      {detail && detail.type === "episode" && (
        <>
          <p className="label">conversation · {detail.episode.scope}</p>
          <p className="sub">{detail.episode.agent} · {detail.episode.provider}{detail.episode.model ? ` · ${detail.episode.model}` : ""} · {date(detail.episode.tEvent)}</p>
          <div className="transcript">
            {(detail.episode.messages ?? [{ role: "text", content: detail.episode.text ?? "" }]).map((m, i) => (
              <p key={i} className={`msg ${m.role}`}><span className="label">{m.role}</span>{m.content}</p>
            ))}
          </div>
          <Entities list={detail.entities} onSelect={onSelect} />
          <Neighbours list={detail.neighbours} onSelect={onSelect} />
          <div className="actions"><ForgetButton armed={confirmForget} arm={() => setConfirmForget(true)} forget={forget} /></div>
        </>
      )}
      {detail && detail.type === "entity" && (
        <>
          <p className="label">{detail.entity.type}</p>
          <h3 className="entity-name">{detail.entity.name}</h3>
          <p className="sub">mentioned {detail.entity.mentions}× · first {date(detail.entity.firstSeen)} · last {date(detail.entity.lastSeen)}</p>
          <ul className="neighbours">
            {detail.mentions.map((m) => (
              <li key={m.id}>
                <button onClick={() => onSelect(m.id)}>
                  <span className="label">{m.type === "note" ? "note" : "conversation"} · {m.scope}</span>
                  <span>{m.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

function ForgetButton({ armed, arm, forget }: { armed: boolean; arm: () => void; forget: () => void }) {
  return armed ? (
    <button className="btn danger" onClick={forget}>Forget for good</button>
  ) : (
    <button className="btn ghost" onClick={arm}>Forget</button>
  );
}

function Entities({ list, onSelect }: { list: { id: string; name: string; type: string }[]; onSelect: (id: string) => void }) {
  if (!list.length) return null;
  return (
    <div className="chips entities">
      {list.map((e) => (
        <button key={e.id} className="chip on" onClick={() => onSelect(e.id)} title={e.type}>{e.name}</button>
      ))}
    </div>
  );
}

function Neighbours({ list, onSelect }: { list: Neighbour[]; onSelect: (id: string) => void }) {
  if (!list.length) return null;
  return (
    <>
      <h4 className="label">connected</h4>
      <ul className="neighbours">
        {list.map((n) => (
          <li key={`${n.kind}-${n.direction}-${n.id}`}>
            <button onClick={() => onSelect(n.id)}>
              <span className={`label${n.kind === "contradicts" ? " red" : ""}`}>
                {(RELATION[n.kind]?.[n.direction] ?? n.kind)}{n.kind === "similar" ? ` · ${n.weight.toFixed(2)}` : ""}
              </span>
              <span>{n.label ?? n.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
