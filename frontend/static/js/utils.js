/* utils.js — shared formatters and small helpers */
window.U = {
  age(secondsOrIso) {
    if (!secondsOrIso) return '-';
    let s;
    if (typeof secondsOrIso === 'number') s = secondsOrIso;
    else s = Math.floor((Date.now() - new Date(secondsOrIso).getTime()) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return Math.round(s) + '秒';
    if (s < 3600) return Math.round(s / 60) + '分';
    if (s < 86400) return Math.round(s / 3600) + '小时';
    return Math.round(s / 86400) + '天';
  },
  ts(isoOrUnix) {
    if (!isoOrUnix) return '-';
    const t = typeof isoOrUnix === 'number' ? isoOrUnix * 1000 : new Date(isoOrUnix).getTime();
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  remain(unixExpire) {
    if (!unixExpire) return '-';
    const diff = unixExpire - Date.now() / 1000;
    if (diff <= 0) return '已过期';
    return this.age(diff);
  },
  humanBytes(b) {
    if (b == null || isNaN(b)) return '-';
    const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'];
    let v = b, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + units[i];
  },
  cpuStr(q) {
    if (q == null) return '-';
    if (/m$/.test(String(q))) return String(q);
    const n = parseFloat(q);
    if (isNaN(n)) return String(q);
    return n >= 1 ? n.toFixed(1) : Math.round(n * 1000) + 'm';
  },
  prettyJSON(obj) {
    try { return JSON.stringify(obj, null, 2); } catch (e) { return String(obj); }
  },
  // minimal reliable YAML dumper for the YAML editor
  toYAML(obj) {
    const unit = '  ';
    function scalar(v) {
      if (v === null || v === undefined) return 'null';
      if (typeof v === 'boolean' || typeof v === 'number') return String(v);
      let s = String(v);
      if (s.includes('\n')) {
        return JSON.stringify(s);
      }
      if (s === '' || /^(null|Null|NULL|true|True|false|False|~|yes|no)$/.test(s) ||
          /^-?[\d.]+(e[+-]?\d+)?$/i.test(s) || /^0x[0-9a-fA-F]+$/.test(s) ||
          /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) || /\s$/.test(s)) {
        return JSON.stringify(s);
      }
      return s;
    }
    function isPlain(v) {
      return v === null || ['boolean', 'number', 'string'].includes(typeof v);
    }
    function isEmpty(v) {
      return v == null ||
        (Array.isArray(v) && !v.length) ||
        (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    }
    function emit(v, indent) {
      const pad = unit.repeat(indent);
      if (isPlain(v) || isEmpty(v)) {
        if (isEmpty(v)) {
          if (Array.isArray(v)) return pad + '[]\n';
          if (typeof v === 'object') return pad + '{}\n';
          return pad + scalar(v) + '\n';
        }
        return pad + scalar(v) + '\n';
      }
      const out = [];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (isPlain(item) || isEmpty(item)) {
            out.push(pad + '- ' + (isEmpty(item) ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)) + '\n');
          } else {
            const body = emit(item, indent + 1).trimEnd().split('\n');
            body[0] = pad + '- ' + body[0].slice((indent + 1) * unit.length);
            out.push(body.join('\n') + '\n');
          }
        }
        return out.join('');
      }
      for (const [k, val] of Object.entries(v)) {
        if (isPlain(val) || isEmpty(val)) {
          const rendered = isEmpty(val) ? (Array.isArray(val) ? '[]' : typeof val === 'object' ? '{}' : null) : null;
          out.push(rendered === null ? pad + k + ': ' + scalar(val) + '\n' : pad + k + ': ' + rendered + '\n');
        } else if (Array.isArray(val) && val.length && val.every(isPlain)) {
          out.push(pad + k + ':' + '\n');
          for (const item of val) out.push(pad + unit + '- ' + scalar(item) + '\n');
        } else {
          out.push(pad + k + ':' + '\n');
          out.push(emit(val, indent + 1));
        }
      }
      return out.join('');
    }
    return emit(obj, 0);
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },
  podStatusColor(pod) {
    if (!pod || !pod.status) return 'default';
    const phase = pod.status.phase;
    const reasons = (pod.status.containerStatuses || []).map((c) => c.state && Object.keys(c.state)[0]).join();
    if (phase === 'Running') {
      const allReady = (pod.status.containerStatuses || []).every((c) => c.ready);
      if (allReady) return 'success';
      if (reasons.includes('running')) return 'primary';
      return 'warning';
    }
    if (phase === 'Succeeded') return 'success';
    if (phase === 'Failed') return 'danger';
    if (phase === 'Pending') return 'warning';
    if (phase === 'Unknown') return 'default';
    return 'default';
  },
  podStatusText(pod) {
    if (!pod || !pod.status) return '-';
    const cs = pod.status.containerStatuses || [];
    if (pod.status.phase === 'Running' && cs.length) {
      const waiting = cs.find((c) => c.state && c.state.waiting && c.state.waiting.reason);
      if (waiting) return waiting.state.waiting.reason;
      const terminatedBad = cs.find((c) => c.state && c.state.terminated && c.state.terminated.exitCode !== 0);
      if (terminatedBad) return 'Error:' + terminatedBad.state.terminated.reason;
      const allReady = cs.every((c) => c.ready);
      return allReady ? 'Running' : 'Running(未就绪)';
    }
    if (pod.status.phase === 'Pending' && cs.length) {
      const waiting = cs.find((c) => c.state && c.state.waiting && c.state.waiting.reason);
      if (waiting) return waiting.state.waiting.reason;
    }
    return pod.status.phase || '-';
  },
  downField(obj, ...path) {
    let cur = obj;
    for (const p of path) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  },
};
