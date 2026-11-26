// SPDX-License-Identifier: AGPL-3.0-or-later
// Standing orders: rules the person gave once, checked before an agent's tool call
// where a hook asks rhizome. Hidden while STANDING_ORDERS is off.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { StandingOrder } from "./types";

export function Orders({ onNotice }: { onNotice: (msg: string) => void }) {
  const [orders, setOrders] = useState<StandingOrder[] | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders((await api.orders()).orders);
    } catch {
      setOrders(null); // off on this server
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!orders) return null;

  const run = async (what: Promise<unknown>, done: string) => {
    try {
      await what;
      onNotice(done);
      await load();
    } catch (err) {
      onNotice(String((err as Error).message));
    }
  };
  const proposed = orders.filter((o) => o.state === "proposed").length;

  return (
    <section>
      <h2 className="label">standing orders</h2>
      <p className="muted small">Your rules for every agent. Where an agent's hook asks rhizome, a call that breaks one is stopped before it runs.</p>
      {proposed > 0 && <p className="label red">{proposed} proposed by an agent · not checked yet</p>}
      {orders.length === 0 ? (
        <p className="muted small">None yet. Tell an agent a rule and ask it to keep it as a standing order.</p>
      ) : (
        <ul className="walls">
          {orders.map((o) => (
            <li key={o.id}>
              <div className="order-says">{o.says}</div>
              <div className="wall-head">
                <span className="label">
                  {o.action} · {o.scope} · {o.state}
                  {o.strikes ? ` · stopped ${o.strikes}` : ""}
                </span>
                <span>
                  {o.state === "active" ? (
                    <button type="button" className="link" onClick={() => void run(api.setOrderState(o.id, "disabled"), "Order disabled.")}>Disable</button>
                  ) : (
                    <button type="button" className="link" onClick={() => void run(api.setOrderState(o.id, "active"), "Order active.")}>Activate</button>
                  )}
                  {" · "}
                  <button type="button" className="link" onClick={() => void run(api.deleteOrder(o.id), "Order deleted.")}>Delete</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
