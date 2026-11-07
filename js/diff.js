/*
 * MyFiles app: edits as small changes ("ops") against the record last loaded from MyFiles, the same as MyFiles Desktop
 * (lib/diff.js), so the server applies only what changed here and keeps what others changed meanwhile (appPatch).
 * Every op carries `was`: the value this phone had before its first edit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_DIFF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const keys = (...objs) => { const s = new Set(); objs.forEach(o => Object.keys(o || {}).forEach(k => s.add(k))); return [...s]; };
  
  const ATT_FIELDS = ['start', 'end', 'sched', 'noClass', 'extra', 'students', 'resolve'];
  function attDiff(base, next) {
    base = base || {}; next = next || {};
    const ops = [];
    ATT_FIELDS.forEach(name => { if (name in next && !same(base[name], next[name])) ops.push({ op: 'field', name, value: clone(next[name]), was: base[name] === undefined ? null : clone(base[name]) }); });
    const bm = base.marks || {}, nm = next.marks || {};
    keys(bm, nm).sort().forEach(key => {
      const b = bm[key] || {}, n = nm[key] || {};
      keys(b, n).sort().forEach(sk => { const v = n[sk] || ''; if ((b[sk] || '') !== v) ops.push({ op: 'mark', key, sk, v, was: b[sk] || '' }); });
    });
    return ops;
  }
  function attApply(rec, ops) {
    const d = clone(rec || {}) || {};
    (ops || []).forEach(o => {
      if (o.op === 'field') d[o.name] = clone(o.value);
      else if (o.op === 'mark') {
        d.marks = d.marks || {};
        const m = d.marks[o.key] = d.marks[o.key] || {};
        if (o.v) m[o.sk] = o.v; else { delete m[o.sk]; if (!Object.keys(m).length) delete d.marks[o.key]; }
      }
    });
    return d;
  }
  
  // Class record: the scores are students[].s[taskKey], the intervention scores interv.s[studentKey][colKey], the flags
  // students[].flag. A change in the rest of a student (name, id, e-mail, order, added or removed) goes as the field "students"
  // (with everything as it is here), before the cell ops; a change in the intervention columns as the field "interv".
  const KR_FIELDS = ['target', 'final', 'finalOn', 'cos'];
  const stuMeta = (list) => (list || []).map(s => { const o = Object.assign({}, s); delete o.s; delete o.flag; return o; });
  const sc = (v) => (v === undefined || v === null ? '' : v);
  function krDiff(base, next) {
    base = base || {}; next = next || {};
    const ops = [];
    KR_FIELDS.forEach(name => { if (name in next && !same(base[name], next[name])) ops.push({ op: 'field', name, value: clone(next[name]), was: base[name] === undefined ? null : clone(base[name]) }); });
    if ('students' in next && !same(stuMeta(base.students), stuMeta(next.students))) ops.push({ op: 'field', name: 'students', value: clone(next.students), was: clone(base.students || []) });
    const bi = base.interv || {}, ni = next.interv;
    if (ni && !same(bi.cols || [], ni.cols || [])) ops.push({ op: 'field', name: 'interv', value: clone(ni), was: clone(base.interv || null) });
    else if (ni) {
      const bs = bi.s || {}, ns = ni.s || {};
      keys(bs, ns).sort().forEach(sk => { const b = bs[sk] || {}, n = ns[sk] || {};
        keys(b, n).sort().forEach(col => { if (String(sc(b[col])) !== String(sc(n[col]))) ops.push({ op: 'iv', sk, col, v: sc(n[col]), was: sc(b[col]) }); }); });
    }
    const bs = {}; (base.students || []).forEach(s => { bs[s.key] = s; });
    (next.students || []).forEach(s => {
      const b = bs[s.key] || {}, bsc = b.s || {}, n = s.s || {};
      if ((b.flag || '') !== (s.flag || '')) ops.push({ op: 'flag', sk: s.key, v: s.flag || '', was: b.flag || '' });
      keys(bsc, n).sort().forEach(task => {
        if (String(sc(bsc[task])) !== String(sc(n[task]))) ops.push({ op: 'score', sk: s.key, task, v: sc(n[task]), was: sc(bsc[task]) });
      });
    });
    return ops;
  }
  function krApply(rec, ops) {
    const d = clone(rec || {}) || {};
    (ops || []).forEach(o => {
      if (o.op === 'field') d[o.name] = clone(o.value);
      else if (o.op === 'score' || o.op === 'flag') {
        const s = (d.students || []).find(x => x.key === o.sk); if (!s) return;
        if (o.op === 'flag') { s.flag = o.v || ''; return; }
        s.s = s.s || {};
        if (o.v === '' || o.v === null || o.v === undefined) delete s.s[o.task]; else s.s[o.task] = o.v;
      } else if (o.op === 'iv') {
        d.interv = d.interv || { cols: [], s: {} }; d.interv.s = d.interv.s || {};
        const m = d.interv.s[o.sk] = d.interv.s[o.sk] || {};
        if (o.v === '' || o.v === null || o.v === undefined) { delete m[o.col]; if (!Object.keys(m).length) delete d.interv.s[o.sk]; } else m[o.col] = o.v;
      }
    });
    return d;
  }
  
  const diffOf = (kind) => kind === 'att' ? attDiff : krDiff;
  const applyOf = (kind) => kind === 'att' ? attApply : krApply;
  return { attDiff, attApply, krDiff, krApply, diffOf, applyOf, same, clone };
});
