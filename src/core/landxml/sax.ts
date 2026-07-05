// src/core/landxml/sax.ts — minimal streaming XML tokenizer.
// No DOMParser (risk R11: memory). No DOM, no Three.js — runs in Node and in a Worker.
//
// Scope: exactly what well-formed-ish LandXML needs. Tolerant by design: malformed
// input degrades to skipped tags / text, never throws. Namespace prefixes are
// stripped to local names. Text may be delivered in multiple chunks — consumers
// must tolerate splits at arbitrary positions (including mid-number).

export interface SaxHandlers {
  open(name: string, attrs: Record<string, string>): void;
  close(name: string): void;
  text(chunk: string): void;
}

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (match, body: string) => {
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const cp = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
  });
}

function localName(qname: string): string {
  const c = qname.indexOf(':');
  return c === -1 ? qname : qname.slice(c + 1);
}

const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAME_RE = /^[^\s/>]+/;

export class SaxTokenizer {
  private buf = '';

  constructor(private readonly h: SaxHandlers) {}

  /** Feed the next chunk of XML text. Chunks may split anywhere. */
  feed(chunk: string): void {
    this.buf = this.buf.length ? this.buf + chunk : chunk;
    this.process();
  }

  /** Signal end of input. Flushes any trailing text; an incomplete trailing tag is dropped. */
  end(): void {
    if (this.buf.length) {
      const lt = this.buf.indexOf('<');
      if (lt !== 0) this.emitText(lt === -1 ? this.buf : this.buf.slice(0, lt));
      this.buf = '';
    }
  }

  private emitText(s: string): void {
    if (s.length) this.h.text(decodeEntities(s));
  }

  private process(): void {
    const buf = this.buf;
    const n = buf.length;
    let pos = 0;
    while (pos < n) {
      const lt = buf.indexOf('<', pos);
      if (lt === -1) {
        this.emitText(buf.slice(pos));
        pos = n;
        break;
      }
      if (lt > pos) this.emitText(buf.slice(pos, lt));
      pos = lt;

      // Comments / processing instructions / CDATA / DOCTYPE-ish.
      if (buf.startsWith('<!--', lt)) {
        const end = buf.indexOf('-->', lt + 4);
        if (end === -1) break; // incomplete — wait for more input
        pos = end + 3;
        continue;
      }
      if (buf.startsWith('<![CDATA[', lt)) {
        const end = buf.indexOf(']]>', lt + 9);
        if (end === -1) break;
        if (end > lt + 9) this.h.text(buf.slice(lt + 9, end)); // CDATA: no entity decoding
        pos = end + 3;
        continue;
      }
      if (buf.startsWith('<?', lt)) {
        const end = buf.indexOf('?>', lt + 2);
        if (end === -1) break;
        pos = end + 2;
        continue;
      }
      // '<!' (DOCTYPE etc.) — also the fallback while a longer sentinel ('<!--',
      // '<![CDATA[') is still split across the chunk boundary: with no '>' yet we
      // hold the buffer either way, so classification stays correct.
      if (buf.startsWith('<!', lt)) {
        if (n - lt < 9 && buf.indexOf('>', lt) === -1) break; // could still become <!-- or <![CDATA[
        const end = buf.indexOf('>', lt + 2);
        if (end === -1) break;
        pos = end + 1;
        continue;
      }
      const gt = buf.indexOf('>', lt + 1);
      if (gt === -1) break; // incomplete tag
      this.handleTag(buf.slice(lt + 1, gt));
      pos = gt + 1;
    }
    this.buf = pos < n ? buf.slice(pos) : '';
  }

  private handleTag(body: string): void {
    if (!body.length) return;
    if (body.charCodeAt(0) === 47 /* '/' */) {
      const name = body.slice(1).trim();
      if (name.length) this.h.close(localName(name));
      return;
    }
    let s = body;
    let selfClosing = false;
    if (s.charCodeAt(s.length - 1) === 47 /* '/' */) {
      selfClosing = true;
      s = s.slice(0, -1);
    }
    const nameMatch = NAME_RE.exec(s);
    if (!nameMatch) return; // garbage tag — tolerate
    const name = localName(nameMatch[0]);
    let attrs: Record<string, string> = EMPTY_ATTRS;
    const rest = s.slice(nameMatch[0].length);
    if (rest.length > 2) {
      attrs = {};
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(rest)) !== null) {
        attrs[localName(m[1] as string)] = decodeEntities((m[2] ?? m[3] ?? '') as string);
      }
    }
    this.h.open(name, attrs);
    if (selfClosing) this.h.close(name);
  }
}

const EMPTY_ATTRS: Record<string, string> = Object.freeze({});
