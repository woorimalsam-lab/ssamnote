// ============================================================
//  수업필기 — 편집기 (캔버스 필기 엔진)
//  - 펜(필압) / 형광펜 / 지우개(획 단위) / 도형 / 텍스트 / 이미지 / 선택 / 손
//  - 손가락: 이동·확대(핀치), 펜·마우스: 필기  (손가락 필기 토글 가능)
//  - 페이지 데이터는 Firestore users/{uid}/pages 에 자동 저장
// ============================================================

import { ctx, toast, showScreen, pageCol } from "./app.js";

const $ = (id) => document.getElementById(id);
const RES = 2; // 캔버스 해상도 배율 (태블릿 메모리 고려)

// ---------- 편집기 상태 ----------
const E = {
  nb: null,
  pages: [],        // {id, order, template, w, h, hasBg, strokes[], objects[], bgImg, bgLoaded}
  cur: 0,
  tool: "pen",
  shape: "line",
  color: "#1a1a1a",
  size: 3,
  fingerDraw: false,
  view: { s: 1, tx: 0, ty: 0 },
  undoStack: [],
  redoStack: [],
  selection: null,  // 선택된 객체 index
  saveTimer: null,
  pendingSave: new Set(), // 저장 대기 중인 페이지 id
  lastNbBump: 0,
};

let viewport, holder, bgC, inkC, liveC, bgG, inkG, liveG;

// ============================================================
//  초기화 & 진입
// ============================================================
export function initEditor() {
  viewport = $("canvas-viewport");
  holder = $("page-holder");
  bgC = $("canvas-bg"); inkC = $("canvas-ink"); liveC = $("canvas-live");
  bgG = bgC.getContext("2d"); inkG = inkC.getContext("2d"); liveG = liveC.getContext("2d");
  bindToolbar();
  bindPointer();
  bindPages();
  bindKeyboard();
}

export async function openNotebook(nb) {
  E.nb = nb;
  E.pages = []; E.cur = 0; E.undoStack = []; E.redoStack = []; E.selection = null;
  $("editor-title").textContent = nb.title;
  showScreen("editor");
  setStatus("불러오는 중…");

  try {
    const { fs } = ctx.fb;
    const snap = await fs.getDocs(fs.query(pageCol(), fs.where("nb", "==", nb.id)));
    E.pages = snap.docs
      .map((d) => {
        const p = d.data();
        return {
          id: d.id, order: p.order ?? 0, template: p.template || "blank",
          w: p.w || 1000, h: p.h || 1414, hasBg: !!p.hasBg,
          strokes: safeParse(p.strokes), objects: safeParse(p.objects),
          bgImg: null, bgLoaded: false,
        };
      })
      .sort((a, b) => a.order - b.order);

    if (E.pages.length === 0) {
      // 페이지가 없으면 하나 생성
      await addPageDoc(nb.template || "blank", 0);
    }
    await showPage(0, true);
    setStatus("저장됨");
  } catch (e) {
    console.error(e);
    toast("노트북을 열지 못했어요: " + (e.message || e));
    showScreen("shelf");
  }
}

function safeParse(s) {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// ============================================================
//  페이지 표시 / 렌더링
// ============================================================
async function showPage(i, refit = false) {
  flushSave();
  E.cur = Math.max(0, Math.min(i, E.pages.length - 1));
  E.undoStack = []; E.redoStack = [];
  clearSelection();
  const p = curPage();

  // 캔버스 크기 설정
  for (const c of [bgC, inkC, liveC]) {
    c.width = Math.round(p.w * RES);
    c.height = Math.round(p.h * RES);
    c.style.width = p.w + "px";
    c.style.height = p.h + "px";
  }
  holder.style.width = p.w + "px";
  holder.style.height = p.h + "px";

  if (refit) fitView();
  applyView();
  updatePageIndicator();

  drawBackground(p);
  if (p.hasBg && !p.bgLoaded) loadPageBg(p);
  await hydrateImages(p);
  redrawInk();
  clearLive();
}

function curPage() { return E.pages[E.cur]; }

function fitView() {
  const p = curPage();
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const s = Math.min((vw - 32) / p.w, (vh - 32) / p.h);
  E.view.s = Math.max(0.1, s);
  E.view.tx = (vw - p.w * E.view.s) / 2;
  E.view.ty = (vh - p.h * E.view.s) / 2;
}

function applyView() {
  const { s, tx, ty } = E.view;
  holder.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

// ---------- 배경(템플릿 / PDF 이미지) ----------
function drawBackground(p) {
  const g = bgG, w = bgC.width, h = bgC.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, w, h);
  g.setTransform(RES, 0, 0, RES, 0, 0);

  if (p.bgImg) {
    g.drawImage(p.bgImg, 0, 0, p.w, p.h);
    return;
  }
  // 템플릿 무늬
  g.strokeStyle = "#d7deef"; g.lineWidth = 1;
  if (p.template === "lines" || p.template === "cornell") {
    for (let y = 90; y < p.h - 40; y += 36) {
      g.beginPath(); g.moveTo(30, y); g.lineTo(p.w - 30, y); g.stroke();
    }
  }
  if (p.template === "grid") {
    for (let x = 0; x <= p.w; x += 30) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, p.h); g.stroke(); }
    for (let y = 0; y <= p.h; y += 30) { g.beginPath(); g.moveTo(0, y); g.lineTo(p.w, y); g.stroke(); }
  }
  if (p.template === "cornell") {
    g.strokeStyle = "#f0a9ab"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(250, 60); g.lineTo(250, p.h - 160); g.stroke();
    g.beginPath(); g.moveTo(30, p.h - 160); g.lineTo(p.w - 30, p.h - 160); g.stroke();
    g.beginPath(); g.moveTo(30, 60); g.lineTo(p.w - 30, 60); g.stroke();
  }
}

async function loadPageBg(p) {
  try {
    const { fs } = ctx.fb;
    const ref = fs.doc(pageCol(), p.id);
    const snap = await fs.getDocs(fs.collection(ref, "bg"));
    if (snap.empty) { p.bgLoaded = true; return; }
    const chunks = snap.docs.map((d) => d.data()).sort((a, b) => a.i - b.i);
    const dataUrl = chunks.map((c) => c.data).join("");
    const img = new Image();
    img.onload = () => {
      p.bgImg = img; p.bgLoaded = true;
      if (curPage() === p) drawBackground(p);
    };
    img.src = dataUrl;
  } catch (e) {
    console.error("배경 불러오기 실패", e);
    p.bgLoaded = true;
  }
}

// 이미지 객체의 dataURL → Image 캐시
function hydrateImages(p) {
  const jobs = [];
  for (const o of p.objects) {
    if (o.type === "image" && !o._img) {
      jobs.push(new Promise((res) => {
        const img = new Image();
        img.onload = () => { o._img = img; res(); };
        img.onerror = () => res();
        img.src = o.data;
      }));
    }
  }
  return Promise.all(jobs);
}

// ---------- 필기 렌더링 ----------
function redrawInk() {
  const p = curPage();
  inkG.setTransform(1, 0, 0, 1, 0, 0);
  inkG.clearRect(0, 0, inkC.width, inkC.height);
  inkG.setTransform(RES, 0, 0, RES, 0, 0);
  for (const st of p.strokes) drawStroke(inkG, st);
  for (const o of p.objects) { if (!o._hidden) drawObject(inkG, o); }
}

function drawStroke(g, st) {
  g.save();
  g.strokeStyle = st.color;
  g.fillStyle = st.color;
  g.lineCap = "round";
  g.lineJoin = "round";

  if (st.t === "pen") {
    const pts = st.p;
    if (pts.length === 1) {
      g.beginPath();
      g.arc(pts[0][0], pts[0][1], st.s * 0.6, 0, Math.PI * 2);
      g.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const pr = (pts[i][2] ?? 0.5);
        g.lineWidth = Math.max(0.5, st.s * (0.55 + 0.9 * pr));
        g.beginPath();
        g.moveTo(pts[i - 1][0], pts[i - 1][1]);
        g.lineTo(pts[i][0], pts[i][1]);
        g.stroke();
      }
    }
  } else if (st.t === "hl") {
    g.globalAlpha = 0.35;
    g.lineCap = "butt";
    g.lineWidth = st.s * 3.2;
    const pts = st.p;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  } else if (st.t === "shape") {
    g.lineWidth = st.s;
    const { x0, y0, x1, y1 } = st;
    g.beginPath();
    if (st.sh === "line" || st.sh === "arrow") {
      g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      if (st.sh === "arrow") {
        const a = Math.atan2(y1 - y0, x1 - x0);
        const L = Math.max(10, st.s * 4);
        for (const d of [-0.5, 0.5]) {
          g.beginPath();
          g.moveTo(x1, y1);
          g.lineTo(x1 - L * Math.cos(a + d), y1 - L * Math.sin(a + d));
          g.stroke();
        }
      }
    } else if (st.sh === "rect") {
      g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (st.sh === "ellipse") {
      g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.restore();
}

function drawObject(g, o) {
  g.save();
  if (o.type === "image" && o._img) {
    g.drawImage(o._img, o.x, o.y, o.w, o.h);
  } else if (o.type === "text") {
    g.fillStyle = o.color || "#1a1a1a";
    g.font = `${o.fs}px "Pretendard", "Noto Sans KR", "Malgun Gothic", sans-serif`;
    g.textBaseline = "top";
    const lines = wrapText(g, o.text, o.w);
    const lh = o.fs * 1.4;
    lines.forEach((ln, i) => g.fillText(ln, o.x, o.y + i * lh));
    o.h = lines.length * lh; // 히트 테스트용 높이 갱신
  }
  g.restore();
}

function wrapText(g, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const ch of para) {
      if (g.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

function clearLive() {
  liveG.setTransform(1, 0, 0, 1, 0, 0);
  liveG.clearRect(0, 0, liveC.width, liveC.height);
  liveG.setTransform(RES, 0, 0, RES, 0, 0);
}

// ============================================================
//  포인터 입력 (필기 / 이동 / 확대)
// ============================================================
const pointers = new Map(); // pointerId -> {x, y}
let gesture = null; // {mode:'draw'|'erase'|'shape'|'pan'|'pinch'|'selectDrag'|'selectResize', ...}

function screenToPage(cx, cy) {
  const r = viewport.getBoundingClientRect();
  const { s, tx, ty } = E.view;
  return { x: (cx - r.left - tx) / s, y: (cy - r.top - ty) / s };
}

function bindPointer() {
  viewport.addEventListener("contextmenu", (e) => e.preventDefault());

  viewport.addEventListener("pointerdown", (e) => {
    if (!E.nb) return;

    // 텍스트 입력 중에 캔버스를 누르면 먼저 입력을 확정하고 그 탭은 무시
    const ta = $("text-editor-overlay");
    if (!ta.classList.contains("hidden")) { commitTextEditor(); return; }

    try { viewport.setPointerCapture(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 두 번째 손가락 → 핀치로 전환 (진행 중이던 손가락 획은 취소)
    if (pointers.size === 2) {
      if (gesture && (gesture.mode === "draw" || gesture.mode === "shape") && gesture.pointerType === "touch") {
        clearLive();
      }
      startPinch();
      return;
    }
    if (pointers.size > 2) return;

    const isTouch = e.pointerType === "touch";
    // 손가락은 기본적으로 화면 이동. 단, 선택/텍스트 도구는 손가락으로도 조작 가능
    const drawingTool = ["pen", "highlighter", "eraser", "shape"].includes(E.tool);
    const panOnly = E.tool === "hand" || (isTouch && !E.fingerDraw && drawingTool);
    const pt = screenToPage(e.clientX, e.clientY);

    if (panOnly) {
      gesture = { mode: "pan", lastX: e.clientX, lastY: e.clientY };
      return;
    }

    // 펜의 옆 버튼(지우개 버튼) → 지우개
    const erasing = E.tool === "eraser" || (e.pointerType === "pen" && (e.buttons & 32));

    if (erasing) {
      gesture = { mode: "erase", removed: [], before: snapshot(), pointerType: e.pointerType };
      eraseAt(pt);
    } else if (E.tool === "pen" || E.tool === "highlighter") {
      gesture = {
        mode: "draw", pointerType: e.pointerType,
        stroke: {
          t: E.tool === "pen" ? "pen" : "hl",
          color: E.color, s: E.size,
          p: [[round1(pt.x), round1(pt.y), round2(e.pressure || 0.5)]],
        },
      };
    } else if (E.tool === "shape") {
      gesture = { mode: "shape", x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, pointerType: e.pointerType };
    } else if (E.tool === "text") {
      openTextEditor(null, pt);
    } else if (E.tool === "select") {
      handleSelectDown(pt, e);
    }
  });

  viewport.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.mode === "pinch") { movePinch(); return; }
    if (gesture.mode === "pan") {
      E.view.tx += e.clientX - gesture.lastX;
      E.view.ty += e.clientY - gesture.lastY;
      gesture.lastX = e.clientX; gesture.lastY = e.clientY;
      applyView();
      return;
    }

    const pt = screenToPage(e.clientX, e.clientY);

    if (gesture.mode === "draw") {
      // coalesced events로 더 부드러운 곡선 (지원 안 하거나 비어 있으면 원본 이벤트 사용)
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs || evs.length === 0) evs = [e];
      for (const ce of evs) {
        const cp = screenToPage(ce.clientX, ce.clientY);
        const pts = gesture.stroke.p;
        const last = pts[pts.length - 1];
        if (Math.hypot(cp.x - last[0], cp.y - last[1]) < 0.7) continue;
        pts.push([round1(cp.x), round1(cp.y), round2(ce.pressure || 0.5)]);
      }
      renderLiveStroke(gesture.stroke);
    } else if (gesture.mode === "erase") {
      eraseAt(pt);
    } else if (gesture.mode === "shape") {
      gesture.x1 = pt.x; gesture.y1 = pt.y;
      clearLive();
      drawStroke(liveG, shapeFromGesture());
    } else if (gesture.mode === "selectDrag") {
      const o = curPage().objects[E.selection];
      o.x = gesture.ox + (pt.x - gesture.px);
      o.y = gesture.oy + (pt.y - gesture.py);
      redrawInk(); positionSelectionBox();
    } else if (gesture.mode === "selectResize") {
      const o = curPage().objects[E.selection];
      const nw = Math.max(30, gesture.ow + (pt.x - gesture.px));
      if (o.type === "image") {
        o.w = nw; o.h = nw * (gesture.oh / gesture.ow);
      } else {
        o.w = nw;
      }
      redrawInk(); positionSelectionBox();
    }
  });

  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (gesture?.mode === "pinch") {
      if (pointers.size < 2) gesture = null;
      return;
    }
    if (!gesture) return;
    const g = gesture; gesture = null;

    if (g.mode === "draw") {
      if (g.stroke.p.length > 0) {
        commit(() => curPage().strokes.push(g.stroke));
      }
      clearLive();
    } else if (g.mode === "erase") {
      clearLive();
      if (g.removed.length > 0) {
        E.undoStack.push(g.before); E.redoStack = [];
        trimUndo(); scheduleSave();
      }
    } else if (g.mode === "shape") {
      const sh = shapeFromGesture(g);
      if (Math.hypot(sh.x1 - sh.x0, sh.y1 - sh.y0) > 3) {
        commit(() => curPage().strokes.push(sh));
      }
      clearLive();
    } else if (g.mode === "selectDrag" || g.mode === "selectResize") {
      E.undoStack.push(g.before); E.redoStack = [];
      trimUndo(); scheduleSave();
    }
  };
  viewport.addEventListener("pointerup", up);
  viewport.addEventListener("pointercancel", up);

  // 데스크톱: 휠 = 스크롤, Ctrl+휠 = 확대
  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(e.clientX, e.clientY, factor);
    } else {
      E.view.tx -= e.deltaX;
      E.view.ty -= e.deltaY;
      applyView();
    }
  }, { passive: false });
}

function renderLiveStroke(st) {
  clearLive();
  drawStroke(liveG, st);
}

// ---------- 핀치 / 줌 ----------
function startPinch() {
  const [a, b] = [...pointers.values()];
  gesture = {
    mode: "pinch",
    d0: Math.hypot(a.x - b.x, a.y - b.y),
    mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2,
    v0: { ...E.view },
  };
}

function movePinch() {
  if (pointers.size < 2) return;
  const [a, b] = [...pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const g = gesture;
  const r = viewport.getBoundingClientRect();
  let s = g.v0.s * (d / g.d0);
  s = Math.max(0.15, Math.min(8, s));
  const k = s / g.v0.s;
  E.view.s = s;
  E.view.tx = (mx - r.left) - k * ((g.mx0 - r.left) - g.v0.tx);
  E.view.ty = (my - r.top) - k * ((g.my0 - r.top) - g.v0.ty);
  applyView();
}

function zoomAt(cx, cy, factor) {
  const r = viewport.getBoundingClientRect();
  const s = Math.max(0.15, Math.min(8, E.view.s * factor));
  const k = s / E.view.s;
  E.view.tx = (cx - r.left) - k * ((cx - r.left) - E.view.tx);
  E.view.ty = (cy - r.top) - k * ((cy - r.top) - E.view.ty);
  E.view.s = s;
  applyView();
}

// ---------- 지우개 (획 단위) ----------
function eraseAt(pt) {
  const p = curPage();
  const r = Math.max(6, E.size * 2.5);
  let hit = false;
  for (let i = p.strokes.length - 1; i >= 0; i--) {
    if (strokeHit(p.strokes[i], pt, r)) {
      gesture.removed.push(p.strokes[i]);
      p.strokes.splice(i, 1);
      hit = true;
    }
  }
  if (hit) redrawInk();
  // 지우개 커서 표시
  clearLive();
  liveG.save();
  liveG.strokeStyle = "#94a3b8"; liveG.lineWidth = 1.5;
  liveG.beginPath(); liveG.arc(pt.x, pt.y, r, 0, Math.PI * 2); liveG.stroke();
  liveG.restore();
}

function strokeHit(st, pt, r) {
  if (st.t === "pen" || st.t === "hl") {
    const rr = r + (st.t === "hl" ? st.s * 1.6 : st.s / 2);
    const pts = st.p;
    if (pts.length === 1) return Math.hypot(pts[0][0] - pt.x, pts[0][1] - pt.y) < rr;
    for (let i = 1; i < pts.length; i++) {
      if (segDist(pt, pts[i - 1], pts[i]) < rr) return true;
    }
    return false;
  }
  if (st.t === "shape") {
    const rr = r + st.s / 2;
    const { x0, y0, x1, y1 } = st;
    if (st.sh === "line" || st.sh === "arrow") return segDist(pt, [x0, y0], [x1, y1]) < rr;
    const L = Math.min(x0, x1), R = Math.max(x0, x1), T = Math.min(y0, y1), B = Math.max(y0, y1);
    if (st.sh === "rect") {
      return segDist(pt, [L, T], [R, T]) < rr || segDist(pt, [R, T], [R, B]) < rr
          || segDist(pt, [R, B], [L, B]) < rr || segDist(pt, [L, B], [L, T]) < rr;
    }
    if (st.sh === "ellipse") {
      const cx = (L + R) / 2, cy = (T + B) / 2, rx = (R - L) / 2 || 1, ry = (B - T) / 2 || 1;
      const v = ((pt.x - cx) / rx) ** 2 + ((pt.y - cy) / ry) ** 2;
      return Math.abs(Math.sqrt(v) - 1) * Math.min(rx, ry) < rr;
    }
  }
  return false;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(p.x - a[0], p.y - a[1]);
  let t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

// ---------- 도형 ----------
function shapeFromGesture(g = gesture) {
  let { x0, y0, x1, y1 } = g;
  // 직선: 수평/수직/45° 근처면 스냅
  if (E.shape === "line" || E.shape === "arrow") {
    const a = Math.atan2(y1 - y0, x1 - x0);
    const snap = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(a - snap) < 0.09) {
      const d = Math.hypot(x1 - x0, y1 - y0);
      x1 = x0 + d * Math.cos(snap);
      y1 = y0 + d * Math.sin(snap);
    }
  }
  return {
    t: "shape", sh: E.shape, color: E.color, s: E.size,
    x0: round1(x0), y0: round1(y0), x1: round1(x1), y1: round1(y1),
  };
}

// ============================================================
//  텍스트 / 이미지 / 선택
// ============================================================
let editingTextIndex = null;

function openTextEditor(index, pt) {
  const ta = $("text-editor-overlay");
  const p = curPage();
  let o;
  if (index != null) {
    o = p.objects[index];
    editingTextIndex = index;
  } else {
    // 기존 텍스트를 탭했으면 그 텍스트를 편집
    const hitIdx = hitObject(pt, "text");
    if (hitIdx != null) return openTextEditor(hitIdx, pt);
    o = { type: "text", x: pt.x, y: pt.y, w: Math.min(400, p.w - pt.x - 20), text: "", fs: 14 + E.size * 2, color: E.color };
    editingTextIndex = null;
    ta.dataset.newObj = JSON.stringify(o);
  }

  const r = viewport.getBoundingClientRect();
  const { s, tx, ty } = E.view;
  ta.style.left = (r.left + tx + o.x * s - 4) + "px";
  ta.style.top = (r.top + ty + o.y * s - 4) + "px";
  ta.style.width = Math.max(120, o.w * s) + "px";
  ta.style.height = Math.max(46, (o.h || o.fs * 1.5) * s + 20) + "px";
  ta.style.fontSize = (o.fs * s) + "px";
  ta.style.color = o.color;
  ta.value = o.text || "";
  ta.classList.remove("hidden");
  if (index != null) { // 편집 중에는 캔버스에서 숨김
    o._hidden = true; redrawInk();
  }
  setTimeout(() => ta.focus(), 30);
}

function commitTextEditor() {
  const ta = $("text-editor-overlay");
  if (ta.classList.contains("hidden")) return;
  const text = ta.value.trim();
  const p = curPage();

  if (editingTextIndex != null) {
    const o = p.objects[editingTextIndex];
    delete o._hidden;
    if (text === "") {
      commit(() => p.objects.splice(editingTextIndex, 1));
    } else if (text !== o.text) {
      commit(() => { o.text = text; });
    } else {
      redrawInk();
    }
  } else if (text !== "") {
    const o = JSON.parse(ta.dataset.newObj || "{}");
    o.text = text;
    commit(() => p.objects.push(o));
  }
  editingTextIndex = null;
  ta.classList.add("hidden");
  ta.value = "";
}

function cancelTextEditor() {
  const ta = $("text-editor-overlay");
  if (editingTextIndex != null) {
    const o = curPage().objects[editingTextIndex];
    if (o) delete o._hidden;
  }
  editingTextIndex = null;
  ta.classList.add("hidden"); // blur 핸들러가 조기 반환하도록 먼저 숨김
  ta.value = "";
  redrawInk();
}

async function insertImage(file) {
  try {
    const dataUrl = await downscaleImage(file, 1100, 0.8);
    const img = await loadImage(dataUrl);
    const p = curPage();
    const maxW = p.w * 0.55;
    const w = Math.min(maxW, img.naturalWidth);
    const h = w * img.naturalHeight / img.naturalWidth;
    // 현재 보이는 영역의 중앙에 배치
    const r = viewport.getBoundingClientRect();
    const c = screenToPage(r.left + r.width / 2, r.top + r.height / 2);
    const o = {
      type: "image", data: dataUrl,
      x: Math.max(10, Math.min(c.x - w / 2, p.w - w - 10)),
      y: Math.max(10, Math.min(c.y - h / 2, p.h - h - 10)),
      w, h, _img: img,
    };
    commit(() => p.objects.push(o));
    selectObject(p.objects.length - 1);
    setTool("select");
  } catch (e) {
    console.error(e);
    toast("이미지를 넣지 못했어요: " + (e.message || e));
  }
}

function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("파일을 읽을 수 없어요"));
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const k = Math.min(1, maxDim / Math.max(w, h));
        w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("이미지 형식을 열 수 없어요"));
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ---------- 선택 ----------
function hitObject(pt, typeFilter = null) {
  const objs = curPage().objects;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (typeFilter && o.type !== typeFilter) continue;
    const h = o.h || 30;
    if (pt.x >= o.x - 6 && pt.x <= o.x + o.w + 6 && pt.y >= o.y - 6 && pt.y <= o.y + h + 6) return i;
  }
  return null;
}

function handleSelectDown(pt, e) {
  const box = $("selection-box");
  // 이미 선택된 상태에서 그 객체를 다시 누르면 이동 시작
  if (E.selection != null) {
    const o = curPage().objects[E.selection];
    if (o && pt.x >= o.x - 8 && pt.x <= o.x + o.w + 8 && pt.y >= o.y - 8 && pt.y <= o.y + (o.h || 30) + 8) {
      gesture = { mode: "selectDrag", px: pt.x, py: pt.y, ox: o.x, oy: o.y, before: snapshot() };
      return;
    }
  }
  const idx = hitObject(pt);
  if (idx != null) {
    selectObject(idx);
    const o = curPage().objects[idx];
    gesture = { mode: "selectDrag", px: pt.x, py: pt.y, ox: o.x, oy: o.y, before: snapshot() };
  } else {
    clearSelection();
  }
}

function selectObject(i) {
  E.selection = i;
  positionSelectionBox();
  $("selection-box").classList.remove("hidden");
}

function positionSelectionBox() {
  if (E.selection == null) return;
  const o = curPage().objects[E.selection];
  if (!o) { clearSelection(); return; }
  const box = $("selection-box");
  box.style.left = o.x + "px";
  box.style.top = o.y + "px";
  box.style.width = o.w + "px";
  box.style.height = (o.h || 30) + "px";
}

function clearSelection() {
  E.selection = null;
  $("selection-box").classList.add("hidden");
}

// ============================================================
//  실행 취소 / 다시 실행 / 저장
// ============================================================
function snapshot() {
  // 획은 새로 추가/삭제만 되므로 얕은 복사, 객체는 제자리에서 수정(이동·크기·텍스트)되므로 개별 복제
  const p = curPage();
  return { strokes: [...p.strokes], objects: p.objects.map((o) => ({ ...o })) };
}

function commit(mutate) {
  E.undoStack.push(snapshot());
  E.redoStack = [];
  trimUndo();
  mutate();
  redrawInk();
  scheduleSave();
}

function trimUndo() { if (E.undoStack.length > 60) E.undoStack.shift(); }

function undo() {
  if (E.undoStack.length === 0) return;
  commitTextEditor();
  const p = curPage();
  E.redoStack.push(snapshot());
  const s = E.undoStack.pop();
  p.strokes = s.strokes; p.objects = s.objects;
  clearSelection(); redrawInk(); scheduleSave();
}

function redo() {
  if (E.redoStack.length === 0) return;
  const p = curPage();
  E.undoStack.push(snapshot());
  const s = E.redoStack.pop();
  p.strokes = s.strokes; p.objects = s.objects;
  clearSelection(); redrawInk(); scheduleSave();
}

function setStatus(t) { $("save-status").textContent = t; }

function scheduleSave() {
  const p = curPage();
  E.pendingSave.add(p.id);
  setStatus("저장 중…");
  clearTimeout(E.saveTimer);
  E.saveTimer = setTimeout(flushSave, 1200);
}

function flushSave() {
  clearTimeout(E.saveTimer);
  if (E.pendingSave.size === 0) return;
  const { fs } = ctx.fb;
  for (const id of E.pendingSave) {
    const p = E.pages.find((x) => x.id === id);
    if (!p) continue;
    const strokes = JSON.stringify(p.strokes);
    const objects = JSON.stringify(p.objects, (k, v) => (k.startsWith("_") ? undefined : v));
    if (strokes.length + objects.length > 950000) {
      toast("⚠ 이 페이지가 너무 무거워요. 이미지를 줄이거나 페이지를 나눠 주세요.");
    }
    // 오프라인이어도 로컬 캐시에 저장되고, 온라인이 되면 자동 동기화됩니다.
    fs.setDoc(fs.doc(pageCol(), p.id), {
      strokes, objects, order: p.order, updatedAt: fs.serverTimestamp(),
    }, { merge: true }).catch((e) => {
      console.error(e);
      setStatus("저장 실패");
      toast("저장에 실패했어요: " + (e.code || e.message));
    });
  }
  E.pendingSave.clear();
  setStatus("저장됨 ✓");
  bumpNotebook();
}

function bumpNotebook() {
  // 노트북의 '마지막 수정' 갱신 (1분에 한 번만)
  const now = Date.now();
  if (now - E.lastNbBump < 60000) return;
  E.lastNbBump = now;
  const { fs, db } = ctx.fb;
  fs.updateDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", E.nb.id), {
    updatedAt: fs.serverTimestamp(), pageCount: E.pages.length,
  }).catch(() => {});
}

// ============================================================
//  페이지 관리
// ============================================================
async function addPageDoc(template, order) {
  const { fs } = ctx.fb;
  const base = E.pages.length ? curPage() : { w: 1000, h: 1414 };
  const ref = fs.doc(pageCol());
  const p = {
    id: ref.id, nb: E.nb.id, order, template,
    w: template === "same" ? base.w : 1000,
    h: template === "same" ? base.h : 1414,
    hasBg: false, strokes: [], objects: [], bgImg: null, bgLoaded: true,
  };
  await fs.setDoc(ref, {
    nb: E.nb.id, order, template: p.template, w: p.w, h: p.h,
    hasBg: false, strokes: "[]", objects: "[]", updatedAt: fs.serverTimestamp(),
  });
  // 현재 페이지 뒤에 삽입
  const insertAt = E.pages.length === 0 ? 0 : E.cur + 1;
  E.pages.splice(insertAt, 0, p);
  E.lastNbBump = 0; bumpNotebook();
  return insertAt;
}

async function addPage(template) {
  const cur = curPage();
  const tpl = template === "current" ? (cur?.template || "blank") : template;
  // 현재 페이지와 다음 페이지 사이의 중간값 (순서 충돌 방지)
  const next = E.pages[E.cur + 1];
  const order = cur ? (next ? (cur.order + next.order) / 2 : cur.order + 1) : 0;
  try {
    const at = await addPageDoc(tpl, order);
    await showPage(at);
    toast("페이지를 추가했어요");
  } catch (e) {
    console.error(e); toast("페이지 추가 실패: " + e.message);
  }
}

async function deleteCurrentPage() {
  if (E.pages.length <= 1) { toast("마지막 페이지는 삭제할 수 없어요"); return; }
  if (!confirm(`${E.cur + 1}쪽을 삭제할까요?`)) return;
  const p = curPage();
  const { fs } = ctx.fb;
  try {
    E.pages.splice(E.cur, 1);
    await showPage(Math.min(E.cur, E.pages.length - 1));
    const ref = fs.doc(pageCol(), p.id);
    const bgSnap = await fs.getDocs(fs.collection(ref, "bg"));
    for (const c of bgSnap.docs) fs.deleteDoc(c.ref);
    await fs.deleteDoc(ref);
    E.lastNbBump = 0; bumpNotebook();
    toast("삭제했어요");
  } catch (e) {
    console.error(e); toast("삭제 실패: " + e.message);
  }
}

function updatePageIndicator() {
  $("btn-page-indicator").textContent = `${E.cur + 1} / ${E.pages.length}`;
  $("btn-page-prev").disabled = E.cur === 0;
  $("btn-page-next").disabled = E.cur === E.pages.length - 1;
}

function renderPagePanel() {
  const list = $("page-list");
  list.innerHTML = "";
  const tplName = { blank: "백지", lines: "줄노트", grid: "모눈", cornell: "코넬" };
  E.pages.forEach((p, i) => {
    const b = document.createElement("button");
    const n = p.strokes.length + p.objects.length;
    b.textContent = `${i + 1}쪽 · ${p.hasBg ? "PDF" : (tplName[p.template] || "백지")}${n ? ` · 필기 ${n}개` : ""}`;
    if (i === E.cur) b.classList.add("current");
    b.addEventListener("click", () => {
      $("page-panel").classList.add("hidden");
      showPage(i, true);
    });
    list.appendChild(b);
  });
}

// ============================================================
//  도구 바 / 이벤트
// ============================================================
function setTool(tool) {
  commitTextEditor();
  E.tool = tool;
  for (const t of ["pen", "highlighter", "eraser", "shape", "text", "image", "select", "hand"]) {
    $("tool-" + t).classList.toggle("selected", t === tool);
  }
  $("shape-options").style.display = tool === "shape" ? "" : "none";
  if (tool !== "select") clearSelection();
}

function bindToolbar() {
  for (const t of ["pen", "highlighter", "eraser", "shape", "text", "select", "hand"]) {
    $("tool-" + t).addEventListener("click", () => setTool(t));
  }
  $("tool-image").addEventListener("click", () => $("input-image").click());
  $("input-image").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) insertImage(f);
  });
  $("shape-options").style.display = "none";
  $("shape-options").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    E.shape = b.dataset.s;
    document.querySelectorAll(".shape-btn").forEach((x) => x.classList.toggle("selected", x === b));
  });

  $("color-row").addEventListener("click", (e) => {
    const b = e.target.closest("button.col"); if (!b) return;
    E.color = b.dataset.c;
    document.querySelectorAll("#color-row .col").forEach((x) => x.classList.toggle("selected", x === b));
    $("color-custom").value = rgbToHex(E.color);
  });
  $("color-custom").addEventListener("input", (e) => {
    E.color = e.target.value;
    document.querySelectorAll("#color-row .col").forEach((x) => x.classList.remove("selected"));
  });

  $("size-slider").addEventListener("input", (e) => {
    E.size = Number(e.target.value);
    $("size-label").textContent = E.size;
  });
  $("finger-draw").addEventListener("change", (e) => { E.fingerDraw = e.target.checked; });

  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  $("btn-back").addEventListener("click", () => {
    commitTextEditor(); flushSave();
    showScreen("shelf");
    E.nb = null;
  });

  // 선택 상자: 삭제 / 크기 조절
  $("sel-delete").addEventListener("click", () => {
    if (E.selection == null) return;
    const i = E.selection;
    commit(() => curPage().objects.splice(i, 1));
    clearSelection();
  });
  $("selection-box").querySelector(".sel-handle").addEventListener("pointerdown", (e) => {
    if (E.selection == null) return;
    e.stopPropagation();
    e.target.setPointerCapture(e.pointerId);
    const o = curPage().objects[E.selection];
    const pt = screenToPage(e.clientX, e.clientY);
    const g = { mode: "selectResize", px: pt.x, py: pt.y, ow: o.w, oh: o.h || 30, before: snapshot() };
    const move = (ev) => {
      const q = screenToPage(ev.clientX, ev.clientY);
      const nw = Math.max(30, g.ow + (q.x - g.px));
      if (o.type === "image") { o.w = nw; o.h = nw * (g.oh / g.ow); }
      else o.w = nw;
      redrawInk(); positionSelectionBox();
    };
    const end = () => {
      e.target.removeEventListener("pointermove", move);
      e.target.removeEventListener("pointerup", end);
      E.undoStack.push(g.before); E.redoStack = [];
      trimUndo(); scheduleSave();
    };
    e.target.addEventListener("pointermove", move);
    e.target.addEventListener("pointerup", end);
  });

  // 선택 도구에서 텍스트 더블탭(더블클릭) → 편집
  viewport.addEventListener("dblclick", (e) => {
    if (E.tool !== "select") return;
    const pt = screenToPage(e.clientX, e.clientY);
    const idx = hitObject(pt, "text");
    if (idx != null) { clearSelection(); openTextEditor(idx, pt); }
  });

  // 텍스트 오버레이: 밖을 누르면 확정, Escape는 취소
  const ta = $("text-editor-overlay");
  ta.addEventListener("blur", commitTextEditor);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancelTextEditor(); }
  });

  // 선택 상자의 삭제 버튼이 캔버스 탭으로 처리되지 않게
  $("sel-delete").addEventListener("pointerdown", (e) => e.stopPropagation());
}

function bindPages() {
  $("btn-page-prev").addEventListener("click", () => showPage(E.cur - 1, true));
  $("btn-page-next").addEventListener("click", () => showPage(E.cur + 1, true));
  $("btn-page-add").addEventListener("click", () => addPage("current"));

  $("btn-page-indicator").addEventListener("click", () => {
    renderPagePanel();
    $("page-panel").classList.remove("hidden");
  });
  $("page-panel-close").addEventListener("click", () => $("page-panel").classList.add("hidden"));

  const menu = $("page-menu");
  $("btn-page-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target.id !== "btn-page-menu") {
      menu.classList.add("hidden");
    }
  });
  const menuDo = (id, fn) => $(id).addEventListener("click", () => { menu.classList.add("hidden"); fn(); });
  menuDo("menu-add-blank", () => addPage("current"));
  menuDo("menu-add-tpl-blank", () => addPage("blank"));
  menuDo("menu-add-tpl-lines", () => addPage("lines"));
  menuDo("menu-add-tpl-grid", () => addPage("grid"));
  menuDo("menu-clear-page", () => {
    if (confirm("이 페이지의 필기를 모두 지울까요? (배경은 유지)")) {
      commit(() => { const p = curPage(); p.strokes = []; p.objects = []; });
    }
  });
  menuDo("menu-delete-page", deleteCurrentPage);

  window.addEventListener("resize", () => { if (E.nb) applyView(); });
  // 앱을 벗어날 때 저장 확정
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
}

function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (!E.nb) return;
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    if (e.key === "Delete" && E.selection != null) {
      const i = E.selection;
      commit(() => curPage().objects.splice(i, 1));
      clearSelection();
    }
  });
}

// ---------- 유틸 ----------
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
function rgbToHex(c) { return c.startsWith("#") ? c : "#1a1a1a"; }
