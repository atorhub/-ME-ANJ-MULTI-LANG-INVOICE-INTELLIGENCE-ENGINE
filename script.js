/* script.js - Ultimate ANJ Dual OCR + Parser + Exports + History
   Assumes pdfjs-dist, tesseract.js v4, html2canvas, jspdf.umd, JSZip loaded in HTML.
*/
(function () {
  'use strict';

  /* ---------- DOM refs ---------- */
  const $ = id => document.getElementById(id);
  const fileInput = $('fileInput');
  const dualOCRBtn = $('dualOCRBtn');
  const ocrOnlyBtn = $('ocrOnlyBtn');
  const parseBtn = $('parseBtn');
  const statusBar = $('statusBar');
  const themeSelect = $('themeSelect');

  const merchantEl = $('merchant');
  const dateEl = $('date');
  const totalEl = $('total');
  const categoryEl = $('category');
  const itemsTable = $('itemsTable');

  const rawTextEl = $('rawText');
  const cleanedTextEl = $('cleanedText');
  const issuesBox = $('issuesBox');
  const jsonPreview = $('jsonPreview');

  const exportJsonBtn = $('exportJsonBtn');
  const exportTxtBtn = $('exportTxtBtn');
  const exportCsvBtn = $('exportCsvBtn');
  const exportPdfBtn = $('exportPdfBtn');
  const exportZipBtn = $('exportZipBtn');

  const loadHistoryBtn = $('loadHistoryBtn');
  const clearHistoryBtn = $('clearHistoryBtn');
  const historyList = $('historyList');

  /* ---------- State ---------- */
  let lastOCR = { quick: '', enhanced: '', combined: '' };
  let lastOCRtext = ''; // convenience alias kept in sync
  let parsedResult = null;

  /* ---------- Utils ---------- */
  function setStatus(msg, ok = true) {
    if (statusBar) {
      statusBar.textContent = msg;
      statusBar.style.color = ok ? '#2ecc71' : '#e74c3c';
    }
    try { console.log('[ANJ]', msg); } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function downloadBlobDirect(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------- IndexedDB (history) ---------- */
  const DB_NAME = 'anj_invoice_db';
  const DB_VER = 1;
  const STORE = 'invoices';
  let db = null;

  function openDB() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB_NAME, DB_VER);
        r.onupgradeneeded = e => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains(STORE)) {
            const s = d.createObjectStore(STORE, { keyPath: 'id' });
            s.createIndex('merchant', 'merchant', { unique: false });
            s.createIndex('date', 'date', { unique: false });
          }
        };
        r.onsuccess = e => { db = e.target.result; res(); };
        r.onerror = e => rej(e);
      } catch (e) { rej(e); }
    });
  }

  function saveInvoice(obj) {
    return new Promise((res, rej) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        st.put(obj);
        tx.oncomplete = () => res();
        tx.onerror = e => rej(e);
      } catch (e) { rej(e); }
    });
  }

  function getAllInvoices() {
    return new Promise((res, rej) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const st = tx.objectStore(STORE);
        const req = st.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = e => rej(e);
      } catch (e) { rej(e); }
    });
  }

  function clearInvoices() {
    return new Promise((res, rej) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        const rq = st.clear();
        rq.onsuccess = () => res();
        rq.onerror = e => rej(e);
      } catch (e) { rej(e); }
    });
  }

  /* ---------- PDF text extraction (pdf.js) ---------- */
  async function extractTextFromPDF(file) {
    try {
      const arr = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: arr }).promise;
      let whole = '';
      const pages = Math.min(pdf.numPages, 20);
      for (let i = 1; i <= pages; i++) {
        const page = await pdf.getPage(i);
        const txtContent = await page.getTextContent();
        const pageText = txtContent.items.map(it => it.str).join(' ');
        whole += pageText + '\n';
      }
      return whole.trim();
    } catch (e) {
      console.warn('extractTextFromPDF failed', e);
      return '';
    }
  }

  /* ---------- render PDF page to image blob for OCR fallback ---------- */
  async function pdfPageToImageBlob(file, pageNumber = 1, scale = 2) {
    try {
      const arr = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: arr }).promise;
      const page = await pdf.getPage(Math.min(pageNumber, pdf.numPages));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      return blob;
    } catch (e) {
      console.warn('pdfPageToImageBlob failed', e);
      return null;
    }
  }

  /* ---------- file to image helper ---------- */
  async function fileToImageBlob(file) {
    if (!file) return null;
    if (file.type && file.type.startsWith('image/')) return file;
    if (file.name && file.name.toLowerCase().endsWith('.pdf')) {
      return await pdfPageToImageBlob(file, 1, 2);
    }
    return null;
  }

  /* ---------- Tesseract v4 recognize wrapper (no worker API) ---------- */
  async function recognizeWithTesseract(blobOrFile) {
    try {
      const out = await Tesseract.recognize(blobOrFile, 'eng');
      const text = (out && (out.data && out.data.text || out.text)) || '';
      return text;
    } catch (e) {
      console.warn('recognizeWithTesseract failed', e);
      return '';
    }
  }

  /* ---------- text helpers ---------- */
  function normalizeText(s) {
    return (s || '').replace(/\r/g, '').replace(/\t/g, ' ').replace(/[ \u00A0]{2,}/g, ' ').trim();
  }
  function toLines(s) { return normalizeText(s).split(/\n/).map(l => l.trim()).filter(Boolean); }
  function parseNumberString(s) {
    if (!s) return null;
    let t = String(s).replace(/[^\d,.\-]/g, '').trim();
    if (!t) return null;
    const lastDot = t.lastIndexOf('.');
    const lastComma = t.lastIndexOf(',');
    if (lastDot > -1 && lastComma > -1) {
      if (lastDot > lastComma) t = t.replace(/,/g, '');
      else t = t.replace(/\./g, '').replace(',', '.');
    } else t = t.replace(/,/g, '');
    const m = t.match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    if (isNaN(n)) return null;
    return Math.round(n * 100);
  }
  function detectCurrency(text) {
    if (!text) return 'INR';
    if (/[₹]/.test(text) || /\bINR\b/i.test(text) || /\bRs\b/i.test(text)) return 'INR';
    if (/\$/.test(text)) return 'USD';
    if (/€/.test(text)) return 'EUR';
    if (/£/.test(text)) return 'GBP';
    return 'INR';
  }
  function formatCents(cents, currSymbol = '₹') {
    if (cents === null || cents === undefined) return '-';
    const neg = cents < 0;
    const v = Math.abs(Math.floor(cents));
    const intPart = Math.floor(v / 100);
    const dec = String(v % 100).padStart(2, '0');
    const intStr = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? '-' : '') + currSymbol + intStr + '.' + dec;
  }
     /* ---------- Parser (robust) ---------- */
  function tryParseDate(s) {
    if (!s) return null;
    s = s.replace(/\./g, '/').replace(/(st|nd|rd|th)/gi, '');
    const rx1 = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/;
    const rx2 = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/;
    const rx3 = /([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/;
    let m;
    if ((m = s.match(rx1))) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.toISOString().slice(0, 10); }
    if ((m = s.match(rx2))) { let y = +m[3]; if (y < 100) y += (y >= 50 ? 1900 : 2000); const d = new Date(y, +m[2] - 1, +m[1]); return d.toISOString().slice(0, 10); }
    if ((m = s.match(rx3))) { const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase()); const d = new Date(+m[3], mon, +m[2]); return d.toISOString().slice(0,10); }
    const p = Date.parse(s); if (!isNaN(p)) return new Date(p).toISOString().slice(0,10);
    return null;
  }

  function parseRawInvoiceText(raw) {
    raw = raw || '';
    const parsed = {
      id: 'bill-' + Date.now(),
      merchant: null,
      date: null,
      total: null,
      items: [],
      raw: raw,
      issues: [],
      confidence: 0,
      created: Date.now(),
      display: {}
    };

    const lines = toLines(raw);
    if (lines.length === 0) {
      parsed.issues.push({ field: 'raw', problem: 'empty' });
      parsed.display = { merchant: '-', date: '-', total: '-', items: [] };
      parsed.confidence = 0;
      return parsed;
    }

    // merchant detection
    (function () {
      for (let i = 0; i < Math.min(6, lines.length); i++) {
        const l = lines[i].replace(/\|/g, ' ').trim();
        if (!l) continue;
        if (/invoice|bill|receipt|gst|tax|phone|tel|address/i.test(l)) continue;
        if (/^[0-9\W]+$/.test(l)) continue;
        parsed.merchant = l.replace(/[^A-Za-z0-9 &\-\.\,\/\(\)]/g, '').trim();
        break;
      }
      if (!parsed.merchant) {
        let best = '';
        for (const l of lines) {
          if (l.length > best.length && /[A-Za-z]/.test(l) && !/invoice|bill|receipt/i.test(l)) best = l;
        }
        parsed.merchant = best || 'UNKNOWN';
      }
    })();

    // date detection
    (function () {
      const cand = (raw.match(/(\d{1,2}[\/\-\.\s]\d{1,2}[\/\-\.\s]\d{2,4}|\d{4}[\/\-\.\s]\d{1,2}[\/\-\.\s]\d{1,2}|[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/g) || []);
      let dt = null;
      for (const c of cand) {
        const t = tryParseDate(c); if (t) { dt = t; break; }
      }
      if (!dt) { for (const l of lines) { const t = tryParseDate(l); if (t) { dt = t; break; } } }
      parsed.date = dt;
    })();

    // total detection
    (function () {
      const tail = lines.slice(Math.max(0, lines.length - 20));
      const values = [];
      tail.forEach(l => {
        if (/total|grand total|net amount|amount due|balance due|payable|invoice total/i.test(l) ||
          /₹|\$|£|€|Rs\b|INR\b/i.test(l)) {
          const nums = l.match(/-?[\d.,]+/g) || [];
          nums.forEach(n => { const p = parseNumberString(n); if (p !== null) values.push(p); });
        }
      });
      if (values.length) parsed.total = { cents: Math.max(...values), currency: detectCurrency(raw) };
      else {
        const all = (raw.match(/-?[\d,.]{2,}/g) || []).map(n => parseNumberString(n)).filter(Boolean);
        if (all.length) parsed.total = { cents: Math.max(...all), currency: detectCurrency(raw) };
      }
    })();

    // items extraction
    (function () {
      const merged = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]; const next = lines[i + 1] || '';
        if (!/[0-9]/.test(l) && /[0-9]/.test(next)) {
          merged.push((l + ' ' + next).trim()); i++;
        } else merged.push(l);
      }
      const finalLines = [];
      for (let i = 0; i < merged.length; i++) {
        let cur = merged[i];
        if (i < merged.length - 1 && /-$/.test(cur.trim())) {
          cur = (cur.replace(/-+$/, '') + ' ' + merged[i + 1]).trim(); i++;
        }
        finalLines.push(cur);
      }

      function mapRowToItem(line) {
        const nums = (line.match(/-?[\d.,]+(?:\.\d{1,2})?/g) || []).map(s => parseNumberString(s)).filter(n => n !== null);
        const currency = detectCurrency(line);
        let name = line.replace(/([₹$€£]?[-]?\d{1,3}(?:[0-9,]*)(?:\.\d{1,2})?)/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (name.length > 120) name = name.slice(0, 120);
        const item = { name: name || '-', qty: null, price: null, total: null, currency };

        if (nums.length >= 3) {
          item.total = nums[nums.length - 1];
          for (let i = nums.length - 2; i >= 0; i--) {
            const cand = nums[i];
            if (Math.abs(cand) < Math.max(100000000, Math.abs(item.total * 2))) { item.price = cand; break; }
          }
          for (let i = 0; i < nums.length; i++) {
            const v = nums[i]; const units = Math.round(v / 100);
            if (units >= 1 && units <= 500 && v % 100 === 0) { item.qty = units; break; }
          }
          if (!item.qty && item.price && item.total) {
            const q = Math.round(item.total / item.price);
            if (q >= 1 && q <= 500) item.qty = q;
          }
        } else if (nums.length === 2) {
          const a = nums[0], b = nums[1];
          if (b > a * 1.05) { item.price = a; item.total = b; const q = Math.round(b / a); if (q >= 1 && q <= 500) item.qty = q; }
          else {
            if (a % 100 === 0 && Math.round(a / 100) >= 1 && Math.round(a / 100) <= 500) {
              item.qty = Math.round(a / 100); item.price = b; item.total = Math.floor(item.price * item.qty);
            } else { item.price = a; item.total = b; }
          }
        } else if (nums.length === 1) {
          item.total = nums[0];
        } else return null;

        if (item.price && !item.total) item.total = Math.floor(item.price * (item.qty || 1));
        if (item.total && !item.price && item.qty) item.price = Math.floor(item.total / (item.qty || 1));
        if (item.qty === null) item.qty = item.price && item.total ? Math.max(1, Math.round(item.total / item.price)) : 1;
        if (item.price !== null) item.price = Number(item.price);
        if (item.total !== null) item.total = Number(item.total);
        item.currency = currency;
        return item;
      }

      const candidates = finalLines.filter(l => /[A-Za-z]/.test(l) && /[0-9]/.test(l));
      const mapped = [];
      for (const r of candidates) { const m = mapRowToItem(r); if (m) mapped.push(m); }
      const seen = new Set(); const cleaned = [];
      for (const it of mapped) {
        const key = (it.name || '') + '|' + (it.total || '') + '|' + (it.price || '');
        if (seen.has(key)) continue;
        seen.add(key);
        if (!(it.total || it.price)) continue;
        cleaned.push(it);
      }
      parsed.items = cleaned;
    })();

    // infer total if missing
    const sumItems = parsed.items.reduce((s, it) => s + (it.total || 0), 0);
    if (!parsed.total && sumItems > 0) parsed.total = { cents: sumItems, currency: detectCurrency(parsed.raw), inferred: true };

    // mismatch detection
    if (parsed.total && sumItems > 0) {
      if (Math.abs(parsed.total.cents - sumItems) > Math.max(200, Math.round(parsed.total.cents * 0.05))) {
        parsed.mismatch = { total: parsed.total.cents, itemsSum: sumItems };
      }
    }

    // issues & confidence
    if (!parsed.merchant || parsed.merchant === 'UNKNOWN') parsed.issues.push({ field: 'merchant', problem: 'missing' });
    if (!parsed.date) parsed.issues.push({ field: 'date', problem: 'missing' });
    if (!parsed.total) parsed.issues.push({ field: 'total', problem: 'missing' });
    if (!parsed.items || parsed.items.length === 0) parsed.issues.push({ field: 'items', problem: 'no_items' });

    let score = 10;
    if (parsed.merchant && parsed.merchant !== 'UNKNOWN') score += 20;
    if (parsed.date) score += 15;
    if (parsed.total) score += 30;
    score += Math.min(25, (parsed.items ? parsed.items.length * 5 : 0));
    if (parsed.mismatch) score = Math.max(30, score - 20);
    parsed.confidence = Math.min(100, score);

    parsed.display = {
      merchant: parsed.merchant || '-',
      date: parsed.date || '-',
      total: parsed.total ? formatCents(parsed.total.cents, parsed.total.currency === 'INR' ? '₹' : (parsed.total.currency === 'USD' ? '$' : parsed.total.currency + ' ')) : '-',
      items: (parsed.items || []).map(it => ({
        name: it.name || '-',
        qty: it.qty || 1,
        price: it.price ? formatCents(it.price, it.currency === 'INR' ? '₹' : '$') : '-',
        total: it.total ? formatCents(it.total, it.currency === 'INR' ? '₹' : '$') : '-'
      }))
    };

    return parsed;
  }

  /* ---------- Render Preview + History ---------- */
  function renderInvoicePreview(parsed) {
    if (!parsed) return;
    merchantEl.textContent = parsed.display.merchant || '-';
    dateEl.textContent = parsed.display.date || '-';
    totalEl.textContent = parsed.display.total || '-';
    categoryEl.textContent = parsed.category || '-';

    itemsTable.innerHTML = '';
    (parsed.display.items || []).forEach(it => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(it.name)}</td><td>${escapeHtml(String(it.qty))}</td><td>${escapeHtml(it.price)}</td><td>${escapeHtml(it.total)}</td>`;
      itemsTable.appendChild(tr);
    });

    rawTextEl.textContent = lastOCR.combined || lastOCRtext || '';
    cleanedTextEl.textContent = parsed.raw || '';
    jsonPreview.textContent = JSON.stringify(parsed, null, 2);

    issuesBox.innerHTML = '';
    if ((parsed.issues || []).length === 0 && !parsed.mismatch) {
      issuesBox.textContent = 'No issues detected.';
    } else {
      (parsed.issues || []).forEach(i => { const d = document.createElement('div'); d.textContent = `Issue: ${i.field} — ${i.problem}`; issuesBox.appendChild(d); });
      if (parsed.mismatch) { const d = document.createElement('div'); d.textContent = `Total mismatch: parsed ${parsed.mismatch.total} vs items sum ${parsed.mismatch.itemsSum}`; issuesBox.appendChild(d); }
    }
  }

  async function renderHistory() {
    try {
      const all = await getAllInvoices();
      historyList.innerHTML = '';
      if (!all || !all.length) { historyList.textContent = 'No history yet.'; return; }
      all.sort((a, b) => b.created - a.created);
      all.forEach(inv => {
        const row = document.createElement('div');
        row.className = 'history-row';
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.padding = '8px';
        row.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
        const left = document.createElement('div'); left.textContent = (inv.merchant || inv.display?.merchant || 'Bill') + ' — ' + (inv.date || '-');
        const right = document.createElement('div'); right.textContent = inv.total ? (inv.total.currency ? (inv.total.currency + ' ') : '') + (inv.total.cents ? (inv.total.cents / 100).toFixed(2) : '-') : '-';
        row.appendChild(left); row.appendChild(right);
        row.addEventListener('click', () => {
          parsedResult = inv;
          lastOCR.combined = inv.raw || '';
          lastOCRtext = lastOCR.combined;
          rawTextEl.textContent = lastOCR.combined;
          cleanedTextEl.textContent = inv.raw || '';
          renderInvoicePreview(parsedResult);
          setStatus('Loaded invoice from history', true);
        });
        historyList.appendChild(row);
      });
    } catch (e) {
      console.error(e); historyList.textContent = 'History load failed';
    }
  }

  /* ----------- Exporters ----------- */
  function filenameBase() {
    const name = parsedResult && parsedResult.merchant ? parsedResult.merchant.replace(/[^a-z0-9]/ig,'_') : 'invoice';
    return `${name}_${Date.now()}`;
  }

  function exportJSON() {
    if (!parsedResult) return setStatus('Nothing to export', false);
    downloadBlobDirect(new Blob([JSON.stringify(parsedResult, null, 2)], { type: 'application/json' }), filenameBase() + '.json');
    setStatus('Exported JSON', true);
  }

  function exportTXT() {
    if (!parsedResult) return setStatus('Nothing to export', false);
    const txt = parsedResult.raw || parsedResult.cleaned || 'No raw OCR text available.';
    downloadBlobDirect(new Blob([txt], { type: 'text/plain' }), filenameBase() + '.txt');
    setStatus('Exported TXT', true);
  }

  function exportCSV() {
    if (!parsedResult) return setStatus('Nothing to export', false);
    let tsv = 'Name\tQty\tPrice\tTotal\n';
    (parsedResult.display.items || []).forEach((it) => {
      tsv += `${it.name}\t${it.qty}\t${it.price}\t${it.total}\n`;
    });
    downloadBlobDirect(new Blob([tsv], { type: 'text/tab-separated-values' }), filenameBase() + '.tsv');
    setStatus('Exported TSV/CSV', true);
  }

  async function exportPDF() {
    if (!parsedResult) return setStatus('Nothing to export', false);
    if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') return setStatus('html2canvas/jsPDF missing', false);
    try {
      const el = document.querySelector('#previewContainer');
      const canvas = await html2canvas(el, { scale: 2 });
      const img = canvas.toDataURL('image/png');
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pad = 20;
      const w = pdf.internal.pageSize.getWidth() - pad * 2;
      const h = (canvas.height * w) / canvas.width;
      pdf.addImage(img, 'PNG', pad, pad, w, h);
      pdf.save(filenameBase() + '.pdf');
      setStatus('Exported PDF', true);
    } catch (e) {
      console.error(e); setStatus('PDF export failed', false);
    }
  }

  async function exportZIP() {
    if (!parsedResult) return setStatus('Nothing to export', false);
    if (typeof JSZip === 'undefined') return setStatus('JSZip missing', false);
    try {
      const zip = new JSZip();
      const base = filenameBase();
      zip.file(base + '.json', JSON.stringify(parsedResult, null, 2));
      zip.file(base + '.txt', parsedResult.raw || '');
      let csv = 'Name\tQty\tPrice\tTotal\n';
      (parsedResult.display.items || []).forEach((it) => (csv += `${it.name}\t${it.qty}\t${it.price}\t${it.total}\n`));
      zip.file(base + '.tsv', csv);
      zip.file(base + '.tally.xml', generateTallyXML(parsedResult));
      try {
        const el = document.querySelector('#previewContainer') || document.body;
        const canvas = await html2canvas(el, { scale: 2 });
        const img = canvas.toDataURL('image/png').split(',')[1];
        zip.file(base + '.png', img, { base64: true });
      } catch (e) { console.warn('PNG capture failed', e); }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlobDirect(blob, base + '.zip');
      setStatus('Exported ZIP', true);
    } catch (e) {
      console.error(e); setStatus('ZIP export failed', false);
    }
  }

  function generateTallyXML(inv) {
    const company = inv.display.merchant || 'Merchant';
    const rawDate = inv.date || new Date().toISOString().slice(0, 10);
    const date = rawDate.replace(/-/g, '');
    const amount = inv.total && inv.total.cents ? (inv.total.cents / 100).toFixed(2) : '0.00';
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<TALLYMESSAGE>
  <VOUCHER>
    <DATE>${date}</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <PARTYNAME>${company}</PARTYNAME>
    <AMOUNT>${amount}</AMOUNT>
    <ALLLEDGERS>`;
    (inv.display.items || []).forEach((it, i) => {
      xml += `
      <LEDGER>
        <NAME>${it.name || `Item${i+1}`}</NAME>
        <AMOUNT>${(it.total && typeof it.total === 'number') ? (it.total/100).toFixed(2) : (it.total||'0')}</AMOUNT>
      </LEDGER>`;
    });
    xml += `
    </ALLLEDGERS>
  </VOUCHER>
</TALLYMESSAGE>`;
    return xml;
  }

  /* ---------- OCR flows (missing functions added) ---------- */
  async function runDualOCR(file) {
    try {
      setStatus('Starting Dual OCR...');
      lastOCR = { quick: '', enhanced: '', combined: '' };
      lastOCRtext = '';
      let pdfText = '';
      if (file.name && file.name.toLowerCase().endsWith('.pdf')) {
        pdfText = await extractTextFromPDF(file);
      }
      const imageBlob = await fileToImageBlob(file);
      if (imageBlob) {
        setStatus('Running quick OCR...');
        lastOCR.quick = await recognizeWithTesseract(imageBlob);
      } else lastOCR.quick = '';
      setStatus('Running enhanced OCR...');
      lastOCR.enhanced = await recognizeWithTesseract(imageBlob || file);
      lastOCR.combined = [pdfText, lastOCR.enhanced, lastOCR.quick].filter(Boolean).join('\n\n');
      lastOCRtext = lastOCR.combined;
      rawTextEl.textContent = lastOCR.combined || '';
      setStatus('Dual OCR complete', true);
      return lastOCR.combined;
    } catch (e) {
      console.error(e);
      setStatus('Dual OCR failed', false);
      return '';
    }
  }

  async function runQuickOCR(file) {
    try {
      setStatus('Running quick OCR...');
      const imageBlob = await fileToImageBlob(file);
      const text = await recognizeWithTesseract(imageBlob || file);
      lastOCR = { quick: text || '', enhanced: '', combined: text || '' };
      lastOCRtext = lastOCR.combined;
      rawTextEl.textContent = lastOCR.combined || '';
      setStatus('Quick OCR complete', true);
      return lastOCR.combined;
    } catch (e) {
      console.error(e);
      setStatus('Quick OCR failed', false);
      return '';
    }
  }

  /* ----------- Event Listeners ----------- */
  dualOCRBtn?.addEventListener('click', async () => {
    const f = fileInput.files[0];
    if (!f) return setStatus('Choose a file first', false);
    await runDualOCR(f);
  });

  ocrOnlyBtn?.addEventListener('click', async () => {
    const f = fileInput.files[0];
    if (!f) return setStatus('Choose a file first', false);
    await runQuickOCR(f);
  });

  parseBtn?.addEventListener('click', async () => {
    const text = lastOCRtext || (lastOCR && lastOCR.combined) || '';
    if (!text) return setStatus('No OCR text available', false);
    try {
      const p = parseRawInvoiceText(text);
      if (!p) return setStatus('Parser failed', false);
      parsedResult = p;
      try {
        if (typeof window.ANJRender === 'function') window.ANJRender(p);
        else renderInvoicePreview(p);
      } catch (e) { renderInvoicePreview(p); }
      await saveInvoice(p).catch(()=>{});
      await renderHistory();
      setStatus('Parsed successfully', true);
    } catch (e) {
      console.error(e);
      setStatus('Parse failed', false);
    }
  });

  exportJsonBtn?.addEventListener('click', () => exportJSON());
  exportTxtBtn?.addEventListener('click', () => exportTXT());
  exportCsvBtn?.addEventListener('click', () => exportCSV());
  exportPdfBtn?.addEventListener('click', () => exportPDF());
  exportZipBtn?.addEventListener('click', () => exportZIP());

  loadHistoryBtn?.addEventListener('click', async () => { await renderHistory(); });
  clearHistoryBtn?.addEventListener('click', async () => { await clearInvoices(); historyList.textContent = 'History Cleared'; });

  /* ---------- Init ---------- */
  (async function initApp() {
    try {
      await openDB();
      const savedTheme = localStorage.getItem('anj_theme');
      if (savedTheme) {
        document.body.className = 'theme-' + savedTheme;
        if (themeSelect) themeSelect.value = savedTheme;
      }
      setStatus('Ready', true);
      await renderHistory();
    } catch (e) {
      console.error(e);
      setStatus('Init failed', false);
    }
  })();

  // expose a couple helpers for debugging if needed
  window._ANJ = window._ANJ || {};
  window._ANJ.runDualOCR = runDualOCR;
  window._ANJ.runQuickOCR = runQuickOCR;
  window._ANJ.parseRawInvoiceText = parseRawInvoiceText;

})();
        - Added robust runDualOCR and runQuickOCR functions (supports PDF text + image OCR fallback).
- Fixed OCR/text state handling (lastOCR + lastOCRtext).
- Implemented IndexedDB history functions and wired renderHistory/saveInvoice.
- Completed parser integration (parseRawInvoiceText) with improved heuristics and confidence scoring.
- Implemented exporters (JSON, TXT, TSV/CSV, PDF via html2canvas+jsPDF, ZIP with JSZip) and Tally XML generator.
- Fixed initialization issue (document.body typo) and theme restore.
- Exposed _ANJ debug helpers for easier mobile testing.
- Defensive checks for missing libs (html2canvas, jspdf, JSZip, Tesseract).
 
