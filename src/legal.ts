// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imprint and privacy policy in English and German. Operator details come
// from deploy-time variables (see README); nothing personal is hardcoded.

import { bloomSvg } from "./bloom";
import { analyticsHost } from "./analytics";
import type { Env } from "./env";

type LegalKind = "privacy" | "datenschutz" | "imprint" | "impressum";
export const LEGAL_PATHS: Record<string, LegalKind> = {
  "/privacy": "privacy",
  "/datenschutz": "datenschutz",
  "/imprint": "imprint",
  "/impressum": "impressum",
};
const UPDATED = { en: "Last updated 26 November 2026", de: "Stand: 26. November 2026" };

interface Operator {
  name: string;
  business?: string;
  street: string;
  city: string;
  country: { en: string; de: string };
  email: string;
  phone?: string;
  authority: string;
}

function operator(env: Env): Operator | null {
  if (!env.OPERATOR_NAME || !env.OPERATOR_STREET || !env.OPERATOR_CITY || !env.OPERATOR_EMAIL) return null;
  return {
    name: env.OPERATOR_NAME,
    business: env.OPERATOR_BUSINESS || undefined,
    street: env.OPERATOR_STREET,
    city: env.OPERATOR_CITY,
    country: { en: env.OPERATOR_COUNTRY_EN ?? "", de: env.OPERATOR_COUNTRY_DE ?? env.OPERATOR_COUNTRY_EN ?? "" },
    email: env.OPERATOR_EMAIL,
    phone: env.OPERATOR_PHONE || undefined,
    authority: env.SUPERVISORY_AUTHORITY ?? "",
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function legalPage(kind: LegalKind, env: Env): Response {
  const o = operator(env);
  if (!o) return new Response("Not found", { status: 404 });
  const de = kind === "datenschutz" || kind === "impressum";
  const lang = de ? "de" : "en";
  const isPrivacy = kind === "privacy" || kind === "datenschutz";
  const title = { privacy: "Privacy policy", datenschutz: "Datenschutzerklärung", imprint: "Imprint", impressum: "Impressum" }[kind];
  const other = { privacy: "/datenschutz", datenschutz: "/privacy", imprint: "/impressum", impressum: "/imprint" }[kind];
  const mail = `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>`;
  const address = `<address>${esc(o.name)}<br>${o.business ? `${esc(o.business)}<br>` : ""}${esc(o.street)}<br>${esc(o.city)}<br>${esc(o.country[lang])}</address>`;
  const host = analyticsHost(env);
  const analytics = host ? (de ? analyticsDe(host) : analyticsEn(host)) : "";
  const body = isPrivacy ? (de ? privacyDe(address, mail, o, analytics) : privacyEn(address, mail, o, analytics)) : imprint(de, address, mail, o);
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · rhizome.</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
:root{--ink:#1A1216;--ink60:rgba(26,18,22,.62);--paper:#F6F1EE;--panel:#EEE6E2;--root:#C81040;--bloom:#FF2E52;--blush:#FFE9EF}
*{box-sizing:border-box}html{background:var(--paper);color:var(--ink)}
body{margin:0;font:16px/1.6 "General Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
::selection{background:var(--blush)}
.wrap{max-width:52em;margin:0 auto;padding:28px clamp(20px,5vw,48px) 48px}
.top{display:flex;align-items:center;justify-content:space-between}
.mark{display:inline-flex;align-items:center;gap:12px;font:600 22.4px/1 "Clash Display","General Sans",sans-serif;color:var(--ink);text-decoration:none;letter-spacing:-.02em}
.mark i{color:var(--bloom);font-style:normal}
.label{font:500 12px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.16em;color:var(--ink60)}
h1{font:600 clamp(32px,4.6vw,48px)/1.1 "Clash Display","General Sans",sans-serif;margin:12px 0 0;letter-spacing:-.01em}
h2{font:600 22px/1.3 "Clash Display","General Sans",sans-serif;margin:36px 0 10px}
p,address{margin:0 0 14px;font-style:normal}
a{color:var(--root);text-underline-offset:3px}
.meta{display:flex;gap:16px;flex-wrap:wrap;margin:14px 0 28px;font-size:14px;color:var(--ink60)}
main{padding-top:clamp(28px,5vw,56px)}
footer{margin-top:56px;padding-top:20px;border-top:1px solid rgba(26,18,22,.1);font-size:14px;color:var(--ink60)}
footer a{color:var(--ink60)}
</style></head><body><div class="wrap">
<div class="top"><a class="mark" href="/">${bloomSvg({ size: 30 })}<span>rhizome<i>.</i></span></a><span class="label">${de ? "rechtliches" : "legal"}</span></div>
<main><h1>${title}</h1>
<div class="meta">${isPrivacy ? `<span>${UPDATED[lang]}</span>` : ""}<a href="${other}" hreflang="${de ? "en" : "de"}">${de ? "English" : "Deutsch"}</a></div>
${body}
</main>
<footer>${de ? "rhizome ist Open Source unter AGPL-3.0-or-later." : "rhizome is open source under AGPL-3.0-or-later."} ·
${de ? `<a href="/datenschutz">Datenschutz</a> · <a href="/impressum">Impressum</a>` : `<a href="/privacy">Privacy</a> · <a href="/imprint">Imprint</a>`}</footer>
</div></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
      "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function imprint(de: boolean, address: string, mail: string, o: Operator) {
  const phone = o.phone ? `<br>${de ? "Telefon" : "Phone"}: <a href="tel:${esc(o.phone.replace(/[^\d+]/g, ""))}">${esc(o.phone)}</a>` : "";
  return de
    ? `<p>Angaben gemäß § 5 DDG:</p>${address}<p>E-Mail: ${mail}${phone}</p>
<h2>Verbraucherstreitbeilegung</h2><p>Wir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>`
    : `<p>Information pursuant to § 5 DDG:</p>${address}<p>Email: ${mail}${phone}</p>
<h2>Consumer dispute resolution</h2><p>We are not willing or obliged to take part in dispute resolution proceedings before a consumer arbitration board.</p>`;
}

function privacyEn(address: string, mail: string, o: Operator, analytics: string) {
  return `<p>rhizome is a private memory for AI agents. It stores what the operator's own agents (for example Claude, ChatGPT or Hermes) write into it, so that they know the operator's way of working across tools. Only members of our organisation can open the memory explorer, and only agents with an API key we issued or a connection we approved can read or write memory. There is no tracking or advertising and no analysis of visitors.</p>
<h2>Controller</h2>${address}<p>Email: ${mail}</p>
<h2>Hosting</h2>
<p>Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA, runs rhizome on our behalf: the program (a Cloudflare Worker), the storage (Durable Objects, R2, D1, Vectorize) and the AI models (Workers AI). To answer a request, Cloudflare processes your IP address, the address requested, the time and details your browser sends, such as its user agent. Requests our Worker handles are logged for at most 7 days; we use these logs only to fix errors and prevent abuse. Fonts are delivered by rhizome itself, so your browser doesn't contact Fontshare or Google.</p>
<h2>Signing in</h2>
<p>The memory explorer is protected by Cloudflare Access. When you sign in, Cloudflare Access checks your email address against our access policy and sets the cookie "CF_Authorization", which keeps you signed in for up to 24 hours. The explorer uses your email address only to find the memory that belongs to you. The cookie is strictly necessary for the sign-in you asked for (§ 25(2) no. 2 TDDDG).</p>
<h2>Memory content</h2>
<p>Memory consists of conversation excerpts, notes and summaries that agents send, the facts and names a language model extracts from them, and vectors that make them searchable. It can contain personal data of the operator and of people mentioned in conversations. The models (bge-m3, bge-reranker, DeepSeek and GLM) run on Workers AI inside Cloudflare's network; rhizome sends no memory to other AI providers on its own. When we connect an AI app such as Claude or ChatGPT (through MCP), the memories it asks for go to that app's provider, under the terms we agreed with that provider. Memory is kept until it is deleted. Deleting an entry removes it, its derived facts, its vectors and the stored raw conversation.</p>
<p>The legal basis is our legitimate interest in giving our own AI agents a shared, consistent memory and in running the service securely (Art. 6(1)(f) GDPR). Cloudflare processes the data as our processor under a data processing agreement (Art. 28 GDPR). Cloudflare, Inc. is certified under the EU-U.S. Data Privacy Framework, for which the European Commission has adopted an adequacy decision (Art. 45 GDPR); the agreement also contains the EU standard contractual clauses. More in <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's privacy policy</a>.</p>
${analytics}<h2>Your rights</h2>
<p>You have the right of access to your personal data (Art. 15 GDPR), to rectification (Art. 16), to erasure (Art. 17), to restriction of processing (Art. 18) and to data portability (Art. 20). To exercise them, email us. You can also lodge a complaint with a data protection supervisory authority (Art. 77 GDPR), for example the one where you live or the one responsible for us: ${esc(o.authority)}.</p>
<p><strong>You may object at any time, on grounds relating to your particular situation, to the processing of your personal data based on Art. 6(1)(f) GDPR (Art. 21 GDPR).</strong></p>`;
}

function privacyDe(address: string, mail: string, o: Operator, analytics: string) {
  return `<p>rhizome ist ein privates Gedächtnis für KI-Agenten. Es speichert, was die eigenen Agenten des Betreibers (etwa Claude, ChatGPT oder Hermes) hineinschreiben, damit sie seine Arbeitsweise werkzeugübergreifend kennen. Den Memory Explorer können nur Mitglieder unserer Organisation öffnen, lesen und schreiben können nur Agenten mit einem von uns ausgegebenen API-Schlüssel oder einer von uns freigegebenen Verbindung. Es gibt kein Tracking, keine Werbung und keine Auswertung von Besuchern.</p>
<h2>Verantwortlicher</h2>${address}<p>E-Mail: ${mail}</p>
<h2>Hosting</h2>
<p>Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA, betreibt rhizome in unserem Auftrag: das Programm (einen Cloudflare Worker), die Speicher (Durable Objects, R2, D1, Vectorize) und die KI-Modelle (Workers AI). Um eine Anfrage zu beantworten, verarbeitet Cloudflare deine IP-Adresse, die aufgerufene Adresse, den Zeitpunkt und Angaben, die dein Browser mitsendet, etwa den User-Agent. Anfragen, die unser Worker bearbeitet, werden höchstens 7 Tage protokolliert; wir nutzen diese Protokolle nur, um Fehler zu beheben und Missbrauch zu verhindern. Schriften liefert rhizome selbst aus, dein Browser verbindet sich also nicht mit Fontshare oder Google.</p>
<h2>Anmeldung</h2>
<p>Der Memory Explorer ist durch Cloudflare Access geschützt. Bei der Anmeldung prüft Cloudflare Access deine E-Mail-Adresse anhand unserer Zugriffsregel und setzt das Cookie „CF_Authorization“, das dich bis zu 24 Stunden angemeldet hält. Der Explorer nutzt deine E-Mail-Adresse nur, um das Gedächtnis zu finden, das dir gehört. Das Cookie ist für die von dir gewünschte Anmeldung unbedingt erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG).</p>
<h2>Gedächtnisinhalte</h2>
<p>Das Gedächtnis besteht aus Gesprächsausschnitten, Notizen und Zusammenfassungen, die Agenten senden, aus Fakten und Namen, die ein Sprachmodell daraus ableitet, und aus Vektoren, die sie durchsuchbar machen. Es kann personenbezogene Daten des Betreibers und von Personen enthalten, die in Gesprächen vorkommen. Die Modelle (bge-m3, bge-reranker, DeepSeek und GLM) laufen auf Workers AI im Netz von Cloudflare; rhizome sendet von sich aus keine Inhalte an andere KI-Anbieter. Verbinden wir eine KI-App wie Claude oder ChatGPT (über MCP), gehen die Erinnerungen, die sie abruft, an deren Anbieter, zu den Bedingungen, die wir mit diesem Anbieter vereinbart haben. Inhalte bleiben gespeichert, bis sie gelöscht werden. Wird ein Eintrag gelöscht, verschwinden er, die daraus abgeleiteten Fakten, seine Vektoren und das gespeicherte Rohgespräch.</p>
<p>Rechtsgrundlage ist unser berechtigtes Interesse, unseren eigenen KI-Agenten ein gemeinsames, stimmiges Gedächtnis zu geben und den Dienst sicher zu betreiben (Art. 6 Abs. 1 lit. f DSGVO). Cloudflare verarbeitet die Daten als unser Auftragsverarbeiter auf Grundlage eines Auftragsverarbeitungsvertrags (Art. 28 DSGVO). Cloudflare, Inc. ist nach dem EU-U.S. Data Privacy Framework zertifiziert, für das ein Angemessenheitsbeschluss der Europäischen Kommission besteht (Art. 45 DSGVO); der Vertrag enthält zusätzlich die EU-Standardvertragsklauseln. Mehr dazu in der <a href="https://www.cloudflare.com/de-de/privacypolicy/">Datenschutzerklärung von Cloudflare</a>.</p>
${analytics}<h2>Deine Rechte</h2>
<p>Du hast das Recht auf Auskunft über deine personenbezogenen Daten (Art. 15 DSGVO), auf Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18) und Datenübertragbarkeit (Art. 20). Schreib uns dazu eine E-Mail. Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), etwa bei der an deinem Wohnort oder bei der für uns zuständigen: ${esc(o.authority)}.</p>
<p><strong>Du kannst der Verarbeitung deiner personenbezogenen Daten auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO jederzeit aus Gründen widersprechen, die sich aus deiner besonderen Situation ergeben (Art. 21 DSGVO).</strong></p>`;
}

const inEu = (host: string) => /(^|\.)eu\.i\.posthog\.com$/.test(new URL(host).hostname);

function analyticsEn(host: string) {
  const where = inEu(host) ? "on servers in the EU (Frankfurt)" : "on servers in the USA";
  return `<h2>Usage analytics</h2>
<p>To see which memory tools are used and where they fail, rhizome sends anonymous usage events to PostHog, Inc., 2261 Market St. #4008, San Francisco, CA 94114, USA, which stores them ${where}. An event holds the tool name, whether the call failed, how long it took, the size of the answer and the name and version of the AI app's software. It holds no memory content, no search queries, no names of projects, no user ids, email or IP addresses and no keys. Calls are counted under a pseudonym that changes every day, and no profiles are created. No cookies are set. The legal basis is our legitimate interest in keeping the service reliable (Art. 6(1)(f) GDPR). PostHog processes the events as our processor under a data processing agreement that contains the EU standard contractual clauses (Art. 28, Art. 46 GDPR). More in <a href="https://posthog.com/privacy">PostHog's privacy policy</a>.</p>
`;
}

function analyticsDe(host: string) {
  const where = inEu(host) ? "auf Servern in der EU (Frankfurt)" : "auf Servern in den USA";
  return `<h2>Nutzungsstatistik</h2>
<p>Um zu sehen, welche Gedächtnis-Werkzeuge genutzt werden und wo sie scheitern, sendet rhizome anonyme Nutzungsereignisse an PostHog, Inc., 2261 Market St. #4008, San Francisco, CA 94114, USA, die ${where} gespeichert werden. Ein Ereignis enthält den Namen des Werkzeugs, ob der Aufruf fehlschlug, wie lange er dauerte, die Größe der Antwort sowie Name und Version der Software der KI-App. Es enthält keine Inhalte des Gedächtnisses, keine Suchanfragen, keine Projektnamen, keine Nutzerkennungen, E-Mail- oder IP-Adressen und keine Schlüssel. Aufrufe werden unter einem Pseudonym gezählt, das täglich wechselt, und es werden keine Profile angelegt. Es werden keine Cookies gesetzt. Rechtsgrundlage ist unser berechtigtes Interesse, den Dienst verlässlich zu betreiben (Art. 6 Abs. 1 lit. f DSGVO). PostHog verarbeitet die Ereignisse als unser Auftragsverarbeiter auf Grundlage eines Auftragsverarbeitungsvertrags mit den EU-Standardvertragsklauseln (Art. 28, Art. 46 DSGVO). Mehr dazu in der <a href="https://posthog.com/privacy">Datenschutzerklärung von PostHog</a>.</p>
`;
}
