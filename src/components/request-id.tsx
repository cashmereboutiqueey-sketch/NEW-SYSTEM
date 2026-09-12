"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The identity of one submission of a form.
 *
 * A sale whose response is lost — the connection drops after the server has
 * committed — looks to the cashier exactly like a sale that failed, and they
 * press the button again. With this field the second press carries the same
 * identity as the first, and the server answers with the result it already
 * recorded instead of selling the garment twice.
 *
 * A new identity is drawn every time the form gets an answer back, success or
 * error, because from then on the next press is a new request. An error
 * rolled everything back, so the retried values may differ and must not be
 * taken for a replay of the old ones.
 */
export function RequestIdField({ state }: { state: unknown }) {
  const [id, setId] = useState(newRequestId);
  const answered = useRef(state);

  useEffect(() => {
    if (answered.current === state) return;
    answered.current = state;
    setId(newRequestId());
  }, [state]);

  return <input type="hidden" name="requestId" value={id} />;
}

/**
 * 32 random hex characters. `crypto.randomUUID` would do, but only exists on
 * HTTPS and localhost, and a till reached over the shop's network by address
 * is neither.
 */
function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
