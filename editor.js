// ============================================================
//  수업필기 — 편집기 (캔버스 필기 엔진)
//  - 펜(필압) / 형광펜 / 지우개(획 단위) / 도형 / 텍스트 / 이미지 / 선택 / 손
//  - 손가락: 이동·확대(핀치), 펜·마우스: 필기  (손가락 필기 토글 가능)
//  - 페이지 데이터는 Firestore users/{uid}/pages 에 자동 저장
// ============================================================

import { ctx, toast, showScreen, pageCol, openRenameNotebook, renderPdfPages, writePdfPage, makeCover } from "./app.js";

const $ = (id) => document.getElementById(id);
const RES = 2; // 캔버스 해상도 배율 (태블릿 메모리 고려)

// ---------- 편집기 상태 ----------
const E = {
  nb: null,
  pages: [],        // {id, order, template, w, h, hasBg, strokes[], objects[], bgImg, bgLoaded}
  cur: 0,
  tool: "pen",
  penStyle: "fountain", // fountain(만년필: 필압 반영) | ball(볼펜: 균일)
  shape: "line",
  color: "#1a1a1a",
  hlColor: "#ffe066",   // 형광펜 전용 색 (파스텔)
  hlStraight: true,     // 형광펜 자동 직선 보정
  size: 3,
  lasso: null,      // 올가미 선택 {strokeIdxs:[], objIdxs:[], bbox:{x,y,w,h}}
  fingerDraw: false,
  scribble: true,   // 긁적여서 지우기 (Scribble to Erase)
  pageFilter: "",   // 페이지 패널 검색어
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
  bgG = bgC.getContext("2d"); inkG = inkC.getContext("2d");
  // 라이브(그리는 중) 레이어는 저지연 모드 — 펜 지연 최소화 (지원 브라우저에서)
  liveG = liveC.getContext("2d", { desynchronized: true });
  bindToolbar();
  bindPointer();
  bindPages();
  bindKeyboard();
  bindAi();
  bindAudio();
  loadPrefs();
  // 데모 모드에서 자동 테스트용 내부 상태 노출
  if (location.hash === "#demo") {
    window.__dbg = { E, curPage, get gesture() { return gesture; } };
  }
}

function syncSizeDots() {
  document.querySelectorAll(".size-dot").forEach((x) =>
    x.classList.toggle("selected", Number(x.dataset.s) === E.size));
}

// ---------- 도구 설정 기억 ----------
const PREFS_KEY = "ssamnote_prefs";

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      color: E.color, size: E.size, penStyle: E.penStyle,
      hlColor: E.hlColor, hlStraight: E.hlStraight,
      fingerDraw: E.fingerDraw, scribble: E.scribble,
    }));
  } catch {}
}

function loadPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch {}
  if (!p) return;
  if (typeof p.size === "number") {
    E.size = p.size;
    $("size-slider").value = p.size;
    $("size-label").textContent = p.size;
    syncSizeDots();
  }
  if (p.penStyle === "ball" || p.penStyle === "fountain") {
    E.penStyle = p.penStyle;
    document.querySelectorAll("#pen-options button").forEach((x) =>
      x.classList.toggle("selected", x.dataset.p === p.penStyle));
  }
  if (typeof p.fingerDraw === "boolean") {
    E.fingerDraw = p.fingerDraw;
    $("finger-draw").checked = p.fingerDraw;
  }
  if (typeof p.scribble === "boolean") {
    E.scribble = p.scribble;
    $("scribble-erase").checked = p.scribble;
  }
  if (typeof p.hlStraight === "boolean") {
    E.hlStraight = p.hlStraight;
    $("hl-straight").checked = p.hlStraight;
  }
  if (typeof p.hlColor === "string") {
    E.hlColor = p.hlColor;
    document.querySelectorAll("#hl-options .hl-col").forEach((x) =>
      x.classList.toggle("selected", x.dataset.h === p.hlColor));
  }
  if (typeof p.color === "string") {
    E.color = p.color;
    let matched = false;
    document.querySelectorAll("#color-row .col").forEach((x) => {
      const sel = x.dataset.c === p.color;
      x.classList.toggle("selected", sel);
      if (sel) matched = true;
    });
    if (p.color.startsWith("#")) $("color-custom").value = p.color;
    if (!matched) document.querySelectorAll("#color-row .col").forEach((x) => x.classList.remove("selected"));
  }
}

// 녹음 중이면 획에 시간·녹음 ID를 기록 (동기화 재생용)
function tagStrokeWithRecording(stroke) {
  if (E.rec && E.rec.pageId === curPage().id) {
    stroke.rt = Math.round((Date.now() - E.rec.t0) / 100) / 10;
    stroke.rid = E.rec.recId;
  }
  return stroke;
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
          w: p.w || 1000, h: p.h || 1414, hasBg: !!p.hasBg, text: p.text || "",
          strokes: safeParse(p.strokes), objects: safeParse(p.objects),
          bgImg: null, bgLoaded: false,
        };
      })
      .sort((a, b) => a.order - b.order);

    if (E.pages.length === 0) {
      // 페이지가 없으면 하나 생성
      await addPageDoc(nb.template || "blank", 0);
    }
    // 마지막으로 편집하던 페이지에서 이어서
    const lastIdx = nb.lastPage ? E.pages.findIndex((p) => p.id === nb.lastPage) : 0;
    await showPage(lastIdx >= 0 ? lastIdx : 0, true);
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
  if (E.rec) { toast("페이지를 옮겨서 녹음을 저장했어요"); stopRecording(); }
  stopPlayback();
  $("audio-panel").classList.add("hidden");
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

  // 보고 있는 페이지를 기억 (다음에 열 때 이어서)
  if (E.nb && E.nb.lastPage !== p.id) {
    E.nb.lastPage = p.id;
    const { fs, db } = ctx.fb;
    fs.updateDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", E.nb.id), { lastPage: p.id }).catch(() => {});
  }

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
  E.fitScale = E.view.s; // 스와이프 페이지 넘김 판단 기준
}

function applyView() {
  const { s, tx, ty } = E.view;
  holder.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

// ---------- 배경(템플릿 / PDF 이미지) ----------
function drawBackground(p) { drawBackgroundTo(bgG, p, RES, bgC.width, bgC.height); }

function drawBackgroundTo(g, p, res, cw, ch) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, cw, ch);
  g.setTransform(res, 0, 0, res, 0, 0);

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
    await new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        p.bgImg = img; p.bgLoaded = true;
        if (curPage() === p) drawBackground(p);
        res();
      };
      img.onerror = () => { p.bgLoaded = true; res(); };
      img.src = dataUrl;
    });
    // 예전에 가져온 PDF 노트북: 첫 페이지로 표지를 소급 생성
    if (E.nb && !E.nb.cover && E.pages[0] === p && p.bgImg) {
      makeCover(dataUrl).then((cover) => {
        if (!cover || !E.nb) return;
        E.nb.cover = cover;
        const { fs: f, db } = ctx.fb;
        f.updateDoc(f.doc(db, "users", ctx.user.uid, "notebooks", E.nb.id), { cover }).catch(() => {});
      });
    }
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
  for (const st of orderedStrokes(p)) {
    // 동기화 재생 중: 아직 안 쓴 필기는 흐리게(고스트)
    if (E.player && st.rid === E.player.recId && st.rt != null && st.rt > E.player.time + 0.2) {
      inkG.globalAlpha = 0.13;
      drawStroke(inkG, st);
      inkG.globalAlpha = 1;
    } else {
      drawStroke(inkG, st);
    }
  }
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
    const ball = st.ps === "ball"; // 볼펜: 필압 무시하고 균일한 굵기
    if (pts.length === 1) {
      g.beginPath();
      g.arc(pts[0][0], pts[0][1], st.s * 0.6, 0, Math.PI * 2);
      g.fill();
    } else if (pts.length === 2) {
      g.lineWidth = ball ? st.s : Math.max(0.5, st.s * (0.45 + 1.1 * (pts[1][2] ?? 0.5)));
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      g.lineTo(pts[1][0], pts[1][1]);
      g.stroke();
    } else if (ball) {
      // 볼펜: 중간점 이차곡선으로 하나의 부드러운 패스
      g.lineWidth = st.s;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        g.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      g.stroke();
    } else {
      // 만년필: 필압별 굵기를 유지하며 구간마다 이차곡선 스무딩
      let px = pts[0][0], py = pts[0][1];
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        g.lineWidth = Math.max(0.5, st.s * (0.45 + 1.1 * (pts[i][2] ?? 0.5)));
        g.beginPath();
        g.moveTo(px, py);
        g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        g.stroke();
        px = mx; py = my;
      }
      const last = pts[pts.length - 1];
      g.lineWidth = Math.max(0.5, st.s * (0.45 + 1.1 * (last[2] ?? 0.5)));
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(last[0], last[1]);
      g.stroke();
    }
  } else if (st.t === "hl") {
    g.globalAlpha = 0.35 * g.globalAlpha; // 고스트(동기화 재생) 알파와 곱해지도록
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
      if (gesture?.holdTimer) clearInterval(gesture.holdTimer);
      if (gesture && (gesture.mode === "draw" || gesture.mode === "shape") && gesture.pointerType === "touch") {
        clearLive();
      }
      startPinch();
      return;
    }
    if (pointers.size > 2) return;

    const isTouch = e.pointerType === "touch";
    // 손가락은 기본적으로 화면 이동. 단, 선택/텍스트 도구는 손가락으로도 조작 가능
    const drawingTool = ["pen", "highlighter", "eraser", "shape", "lasso"].includes(E.tool);
    const panOnly = E.tool === "hand" || (isTouch && !E.fingerDraw && drawingTool);
    const pt = screenToPage(e.clientX, e.clientY);

    if (panOnly) {
      // 재생 중 ✋ 손 도구로 필기를 탭하면 그 시점으로 이동
      if (E.tool === "hand" && E.player) seekToStrokeAt(pt);
      gesture = {
        mode: "pan", lastX: e.clientX, lastY: e.clientY,
        startX: e.clientX, startY: e.clientY, isTouch,
      };
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
        lastMove: Date.now(),
        stroke: {
          t: E.tool === "pen" ? "pen" : "hl",
          ...(E.tool === "pen" ? { ps: E.penStyle } : {}),
          color: E.tool === "pen" ? E.color : E.hlColor,
          s: E.size,
          p: [[round1(pt.x), round1(pt.y), round2(e.pressure || 0.5)]],
        },
      };
      // 그리다 잠깐 멈추면 도형으로 보정 (직선/원/사각형)
      gesture.holdTimer = setInterval(checkHoldShape, 130);
    } else if (E.tool === "lasso") {
      if (E.lasso && ptInRect(pt, E.lasso.bbox, 8)) {
        // 선택 영역 안을 누르면 이동 시작
        gesture = { mode: "lassoMove", px: pt.x, py: pt.y, before: prepareLassoMove(), pointerType: e.pointerType };
      } else {
        clearLasso();
        gesture = { mode: "lasso", pts: [[pt.x, pt.y]], pointerType: e.pointerType };
      }
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
      let moved = false;
      for (const ce of evs) {
        const cp = screenToPage(ce.clientX, ce.clientY);
        const pts = gesture.stroke.p;
        const last = pts[pts.length - 1];
        if (Math.hypot(cp.x - last[0], cp.y - last[1]) < 0.7) continue;
        pts.push([round1(cp.x), round1(cp.y), round2(ce.pressure || 0.5)]);
        moved = true;
      }
      if (moved) gesture.lastMove = Date.now();
      renderLiveStroke(gesture.stroke);
    } else if (gesture.mode === "erase") {
      eraseAt(pt);
    } else if (gesture.mode === "lasso") {
      const last = gesture.pts[gesture.pts.length - 1];
      if (Math.hypot(pt.x - last[0], pt.y - last[1]) > 3) gesture.pts.push([pt.x, pt.y]);
      drawLassoPath(gesture.pts);
    } else if (gesture.mode === "lassoMove") {
      const dx = pt.x - gesture.px, dy = pt.y - gesture.py;
      gesture.px = pt.x; gesture.py = pt.y;
      moveLassoSelection(dx, dy);
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
    if (g.holdTimer) clearInterval(g.holdTimer);

    if (g.mode === "draw") {
      if (g.stroke.p.length > 0) {
        // 긁적여서 지우기: 펜으로 쓱쓱 문지른 자국이면 아래 필기를 지움
        if (g.stroke.t === "pen" && E.scribble && tryScribbleErase(g.stroke)) {
          clearLive();
          return;
        }
        // 형광펜 자동 직선 보정 (밑줄 긋기)
        if (g.stroke.t === "hl" && E.hlStraight) straightenHl(g.stroke);
        commit(() => curPage().strokes.push(tagStrokeWithRecording(g.stroke)));
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
        commit(() => curPage().strokes.push(tagStrokeWithRecording(sh)));
      }
      clearLive();
    } else if (g.mode === "lasso") {
      clearLive();
      finishLasso(g.pts);
    } else if (g.mode === "lassoMove") {
      E.undoStack.push(g.before); E.redoStack = [];
      trimUndo(); scheduleSave();
    } else if (g.mode === "selectDrag" || g.mode === "selectResize") {
      E.undoStack.push(g.before); E.redoStack = [];
      trimUndo(); scheduleSave();
    } else if (g.mode === "pan") {
      // 손가락 스와이프로 페이지 넘김 (화면에 맞춰진 상태에서만 — 확대 중엔 이동으로 동작)
      if (g.isTouch && E.pages.length > 1 && E.view.s <= (E.fitScale || 0) * 1.05) {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (Math.abs(dx) > 70 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
          if (dx < 0 && E.cur < E.pages.length - 1) { showPage(E.cur + 1, true); return; }
          if (dx > 0 && E.cur > 0) { showPage(E.cur - 1, true); return; }
        }
        // 넘길 페이지가 없거나 짧은 스와이프면 제자리로
        fitView(); applyView();
      }
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

// ---------- 형광펜: 자동 직선 보정 ----------
function straightenHl(st) {
  const pts = st.p;
  if (pts.length < 3) return;
  const p0 = pts[0], pn = pts[pts.length - 1];
  const chord = Math.hypot(pn[0] - p0[0], pn[1] - p0[1]);
  if (chord < 40) return;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len > chord * 1.3) return; // 많이 구불거리면 그대로 둠
  let maxD = 0;
  for (const q of pts) maxD = Math.max(maxD, segDist({ x: q[0], y: q[1] }, p0, pn));
  if (maxD < Math.max(7, chord * 0.07)) {
    st.p = [[p0[0], p0[1], 0.5], [pn[0], pn[1], 0.5]];
  }
}

// 형광펜은 항상 글씨(펜·도형) 아래에 깔리도록 그리는 순서 정렬
function orderedStrokes(p) {
  const hl = [], rest = [];
  for (const st of p.strokes) (st.t === "hl" ? hl : rest).push(st);
  return hl.concat(rest);
}

// ---------- 긁적여서 지우기 (Scribble to Erase) ----------
function isScribble(pts) {
  if (pts.length < 12) return false;
  // 좌우 방향 전환 횟수
  let rev = 0, last = 0;
  let len = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const s = dx > 0.5 ? 1 : dx < -0.5 ? -1 : 0;
    if (s && last && s !== last) rev++;
    if (s) last = s;
    len += Math.hypot(dx, pts[i][1] - pts[i - 1][1]);
    x0 = Math.min(x0, pts[i][0]); y0 = Math.min(y0, pts[i][1]);
    x1 = Math.max(x1, pts[i][0]); y1 = Math.max(y1, pts[i][1]);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
  // 지그재그가 5회 이상 + 좁은 영역을 빽빽하게 오간 자국만 (글씨 오인 방지)
  return rev >= 5 && len > 2.5 * diag;
}

function tryScribbleErase(scr) {
  if (!isScribble(scr.p)) return false;
  const p = curPage();
  const R = Math.max(10, scr.s * 3);
  const nearScribble = (x, y) => {
    for (let b = 0; b < scr.p.length; b += 3) {
      if (Math.hypot(x - scr.p[b][0], y - scr.p[b][1]) < R) return true;
    }
    return false;
  };
  const hits = [];
  for (let i = 0; i < p.strokes.length; i++) {
    const st = p.strokes[i];
    const pts = strokePoints(st);
    let near = 0;
    const need = st.t === "shape" ? 1 : 2; // 도형은 꼭짓점 1개, 획은 2점 이상 겹쳐야
    for (let a = 0; a < pts.length; a += st.t === "shape" ? 1 : 2) {
      if (nearScribble(pts[a][0], pts[a][1]) && ++near >= need) { hits.push(i); break; }
    }
  }
  if (hits.length === 0) return false; // 빈 곳에 그린 지그재그는 그냥 필기로 남김
  E.undoStack.push(snapshot());
  E.redoStack = [];
  trimUndo();
  for (const i of hits.sort((a, b) => b - a)) p.strokes.splice(i, 1);
  redrawInk();
  scheduleSave();
  return true;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(p.x - a[0], p.y - a[1]);
  let t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

// ---------- 그리다 멈추면 도형 보정 (직선/원/사각형) ----------
function recognizeShape(pts) {
  const n = pts.length;
  if (n < 8) return null;
  let len = 0, L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    L = Math.min(L, pts[i][0]); T = Math.min(T, pts[i][1]);
    R = Math.max(R, pts[i][0]); B = Math.max(B, pts[i][1]);
  }
  const p0 = pts[0], pn = pts[n - 1];
  const chord = Math.hypot(pn[0] - p0[0], pn[1] - p0[1]);

  // 직선: 양 끝을 이은 선에서 거의 벗어나지 않음
  if (chord > 40 && len < chord * 1.25) {
    let maxD = 0;
    for (const q of pts) maxD = Math.max(maxD, segDist({ x: q[0], y: q[1] }, p0, pn));
    if (maxD < Math.max(5, chord * 0.05)) {
      return { sh: "line", x0: p0[0], y0: p0[1], x1: pn[0], y1: pn[1] };
    }
  }

  // 닫힌 도형(원/사각형): 시작·끝이 가깝고 충분히 큼
  const rx = (R - L) / 2, ry = (B - T) / 2;
  if (chord < len * 0.3 && len > 80 && rx > 14 && ry > 14) {
    const cx = (L + R) / 2, cy = (T + B) / 2;
    let eSum = 0, rSum = 0;
    for (const [x, y] of pts) {
      eSum += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1); // 타원 궤도에서 벗어난 정도
      rSum += Math.min(Math.abs(x - L), Math.abs(x - R), Math.abs(y - T), Math.abs(y - B)); // 테두리에서 벗어난 정도
    }
    const eErr = eSum / n;
    const rErr = rSum / n / Math.min(rx, ry);
    if (eErr < 0.16 && eErr <= rErr * 1.1) return { sh: "ellipse", x0: L, y0: T, x1: R, y1: B };
    if (rErr < 0.12) return { sh: "rect", x0: L, y0: T, x1: R, y1: B };
  }
  return null;
}

function checkHoldShape() {
  const g = gesture;
  if (!g || g.mode !== "draw" || g.stroke.t !== "pen") return;
  if (Date.now() - g.lastMove < 600) return; // 0.6초 이상 멈춰야
  const rec = recognizeShape(g.stroke.p);
  if (!rec) return;
  clearInterval(g.holdTimer);
  // 도형 제스처로 전환 — 계속 끌면 크기·끝점 조절
  gesture = {
    mode: "shape", x0: rec.x0, y0: rec.y0, x1: rec.x1, y1: rec.y1,
    shapeType: rec.sh, pointerType: g.pointerType,
  };
  clearLive();
  drawStroke(liveG, shapeFromGesture(gesture));
  if (navigator.vibrate) navigator.vibrate(15);
}

// ---------- 도형 ----------
function shapeFromGesture(g = gesture) {
  let { x0, y0, x1, y1 } = g;
  const sh = g.shapeType || E.shape; // 도형 도구 또는 자동 보정으로 인식된 도형
  // 직선: 수평/수직/45° 근처면 스냅
  if (sh === "line" || sh === "arrow") {
    const a = Math.atan2(y1 - y0, x1 - x0);
    const snap = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(a - snap) < 0.09) {
      const d = Math.hypot(x1 - x0, y1 - y0);
      x1 = x0 + d * Math.cos(snap);
      y1 = y0 + d * Math.sin(snap);
    }
  }
  return {
    t: "shape", sh, color: E.color, s: E.size,
    x0: round1(x0), y0: round1(y0), x1: round1(x1), y1: round1(y1),
  };
}

// ============================================================
//  올가미 (영역 선택 → 이동/삭제)
// ============================================================
function drawLassoPath(pts) {
  clearLive();
  liveG.save();
  liveG.strokeStyle = "#2d68ff";
  liveG.lineWidth = 1.5;
  liveG.setLineDash([6, 5]);
  liveG.beginPath();
  liveG.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) liveG.lineTo(pts[i][0], pts[i][1]);
  liveG.stroke();
  liveG.restore();
}

function ptInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ptInRect(pt, r, pad = 0) {
  return pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad;
}

function strokePoints(st) {
  if (st.t === "shape") {
    return [[st.x0, st.y0], [st.x1, st.y1], [(st.x0 + st.x1) / 2, (st.y0 + st.y1) / 2]];
  }
  return st.p;
}

function finishLasso(poly) {
  if (poly.length < 3) return;
  const p = curPage();
  const strokeIdxs = [], objIdxs = [];
  p.strokes.forEach((st, i) => {
    if (strokePoints(st).some(([x, y]) => ptInPoly(x, y, poly))) strokeIdxs.push(i);
  });
  p.objects.forEach((o, i) => {
    const cx = o.x + o.w / 2, cy = o.y + (o.h || 30) / 2;
    if (ptInPoly(cx, cy, poly)) objIdxs.push(i);
  });
  if (strokeIdxs.length === 0 && objIdxs.length === 0) { clearLasso(); return; }

  // 선택 범위(바운딩 박스) 계산
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of strokeIdxs) {
    for (const [x, y] of strokePoints(p.strokes[i])) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  for (const i of objIdxs) {
    const o = p.objects[i];
    x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + (o.h || 30));
  }
  E.lasso = { strokeIdxs, objIdxs, bbox: { x: x0 - 6, y: y0 - 6, w: x1 - x0 + 12, h: y1 - y0 + 12 } };
  const box = $("selection-box");
  box.classList.add("lasso-mode");
  box.classList.remove("hidden");
  positionSelectionBox();
  toast(`${strokeIdxs.length + objIdxs.length}개 선택됨 — 끌어서 이동, 🗑로 삭제`);
}

// 이동 전에 실행 취소용 스냅샷을 만들고, 선택된 획의 점 배열을 복제해 안전하게 수정
function prepareLassoMove() {
  const before = snapshot();
  const p = curPage();
  for (const i of E.lasso.strokeIdxs) {
    const st = p.strokes[i];
    p.strokes[i] = st.t === "shape" ? { ...st } : { ...st, p: st.p.map((q) => [...q]) };
  }
  return before;
}

function moveLassoSelection(dx, dy) {
  const p = curPage();
  for (const i of E.lasso.strokeIdxs) {
    const st = p.strokes[i];
    if (st.t === "shape") { st.x0 += dx; st.y0 += dy; st.x1 += dx; st.y1 += dy; }
    else for (const q of st.p) { q[0] += dx; q[1] += dy; }
  }
  for (const i of E.lasso.objIdxs) {
    const o = p.objects[i];
    o.x += dx; o.y += dy;
  }
  E.lasso.bbox.x += dx; E.lasso.bbox.y += dy;
  redrawInk();
  positionSelectionBox();
}

function deleteLassoSelection() {
  const { strokeIdxs, objIdxs } = E.lasso;
  commit(() => {
    const p = curPage();
    for (const i of [...strokeIdxs].sort((a, b) => b - a)) p.strokes.splice(i, 1);
    for (const i of [...objIdxs].sort((a, b) => b - a)) p.objects.splice(i, 1);
  });
  clearLasso();
}

function clearLasso() {
  E.lasso = null;
  const box = $("selection-box");
  box.classList.remove("lasso-mode");
  if (E.selection == null) box.classList.add("hidden");
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
  const box = $("selection-box");
  if (E.lasso) {
    const b = E.lasso.bbox;
    box.style.left = b.x + "px";
    box.style.top = b.y + "px";
    box.style.width = b.w + "px";
    box.style.height = b.h + "px";
    return;
  }
  if (E.selection == null) return;
  const o = curPage().objects[E.selection];
  if (!o) { clearSelection(); return; }
  box.style.left = o.x + "px";
  box.style.top = o.y + "px";
  box.style.width = o.w + "px";
  box.style.height = (o.h || 30) + "px";
}

function clearSelection() {
  E.selection = null;
  E.lasso = null;
  const box = $("selection-box");
  box.classList.remove("lasso-mode");
  box.classList.add("hidden");
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
    // 녹음도 함께 삭제
    const audioSnap = await fs.getDocs(fs.collection(ref, "audio"));
    for (const a of audioSnap.docs) {
      const chunks = await fs.getDocs(fs.collection(a.ref, "chunks"));
      for (const c of chunks.docs) fs.deleteDoc(c.ref);
      fs.deleteDoc(a.ref);
    }
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

// 페이지 검색: PDF 추출 텍스트 + 텍스트 상자 내용에서 찾기
function pageMatches(p, q) {
  if (!q) return true;
  if ((p.text || "").toLowerCase().includes(q)) return true;
  return p.objects.some((o) => o.type === "text" && (o.text || "").toLowerCase().includes(q));
}

function renderPagePanel() {
  const list = $("page-list");
  list.innerHTML = "";
  const q = E.pageFilter;
  let shown = 0;
  E.pages.forEach((p, i) => {
    if (!pageMatches(p, q)) return;
    shown++;
    const b = document.createElement("button");
    b.className = "page-thumb";
    if (i === E.cur) b.classList.add("current");

    const th = renderPageThumb(p, 128);
    const cap = document.createElement("span");
    cap.textContent = `${i + 1}쪽`;
    b.append(th, cap);
    b.addEventListener("click", () => {
      $("page-panel").classList.add("hidden");
      showPage(i, true);
    });
    list.appendChild(b);
  });
  if (shown === 0) {
    list.innerHTML = `<p class="audio-empty" style="grid-column: 1 / -1;">"${q}"를 찾지 못했어요</p>`;
  }
}

// 페이지 미리보기(썸네일) 렌더링
function renderPageThumb(p, w) {
  const c = document.createElement("canvas");
  const k = w / p.w;
  c.width = w;
  c.height = Math.round(p.h * k);
  const g = c.getContext("2d");
  drawBackgroundTo(g, p, k, c.width, c.height);
  g.setTransform(k, 0, 0, k, 0, 0);
  for (const st of orderedStrokes(p)) drawStroke(g, st);
  for (const o of p.objects) { if (!o._hidden) drawObject(g, o); }
  // 아직 배경을 안 불러온 PDF 페이지 표시
  if (p.hasBg && !p.bgImg) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#94a3b8";
    g.font = "12px sans-serif";
    g.textAlign = "center";
    g.fillText("PDF", c.width / 2, c.height / 2);
  }
  return c;
}

// ---------- 기존 노트북에 PDF 삽입 ----------
async function insertPdf(file) {
  const modal = $("modal-progress");
  const setP = (t, r) => {
    modal.classList.remove("hidden");
    $("progress-title").textContent = "PDF 삽입 중…";
    $("progress-text").textContent = t;
    $("progress-bar").style.width = Math.round(r * 100) + "%";
  };
  try {
    flushSave();
    setP(file.name, 0);
    const cur = curPage();
    const next = E.pages[E.cur + 1];
    const newPages = [];
    await renderPdfPages(file, async (pg) => {
      setP(`${pg.i} / ${pg.n} 페이지`, (pg.i - 1) / pg.n);
      // 현재 페이지와 다음 페이지 사이에 순서 배치
      const step = next ? (next.order - cur.order) / (pg.n + 1) : 1;
      const order = cur.order + step * pg.i;
      const id = await writePdfPage(E.nb.id, order, pg);
      newPages.push({
        id, order, template: "blank", w: pg.w, h: pg.h, hasBg: true, text: pg.text || "",
        strokes: [], objects: [], bgImg: null, bgLoaded: false,
      });
    });
    E.pages.splice(E.cur + 1, 0, ...newPages);
    modal.classList.add("hidden");
    E.lastNbBump = 0; bumpNotebook();
    updatePageIndicator();
    toast(`${newPages.length}쪽을 삽입했어요`);
    await showPage(E.cur + 1, true);
  } catch (e) {
    console.error(e);
    modal.classList.add("hidden");
    toast("PDF 삽입에 실패했어요: " + (e.message || e));
  }
}

// ============================================================
//  PDF로 내보내기 (배경 + 필기 합성)
// ============================================================
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("스크립트를 불러올 수 없어요: " + src));
    document.head.appendChild(s);
  });
}

async function exportPdf() {
  const modal = $("modal-progress");
  const setProg = (t, ratio) => {
    modal.classList.remove("hidden");
    $("progress-title").textContent = "PDF 만드는 중…";
    $("progress-text").textContent = t;
    $("progress-bar").style.width = Math.round(ratio * 100) + "%";
  };
  try {
    flushSave();
    setProg("준비 중…", 0);
    await loadScript(JSPDF_URL);
    const { jsPDF } = window.jspdf;
    let doc = null;
    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    const SCALE = 2;

    for (let i = 0; i < E.pages.length; i++) {
      const p = E.pages[i];
      setProg(`${i + 1} / ${E.pages.length} 페이지`, i / E.pages.length);
      if (p.hasBg && !p.bgLoaded) await loadPageBg(p);
      await hydrateImages(p);

      c.width = Math.round(p.w * SCALE);
      c.height = Math.round(p.h * SCALE);
      drawBackgroundTo(g, p, SCALE, c.width, c.height);
      g.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      for (const st of orderedStrokes(p)) drawStroke(g, st);
      for (const o of p.objects) drawObject(g, o);

      const img = c.toDataURL("image/jpeg", 0.85);
      const fmt = [p.w, p.h];
      const ori = p.w > p.h ? "l" : "p";
      if (!doc) doc = new jsPDF({ orientation: ori, unit: "pt", format: fmt });
      else doc.addPage(fmt, ori);
      doc.addImage(img, "JPEG", 0, 0, p.w, p.h);
    }
    doc.save((E.nb.title || "노트") + ".pdf");
    modal.classList.add("hidden");
    toast("PDF로 저장했어요");
  } catch (e) {
    console.error(e);
    modal.classList.add("hidden");
    toast("PDF 내보내기에 실패했어요: " + (e.message || e));
  }
}

// ============================================================
//  도구 바 / 이벤트
// ============================================================
function setTool(tool) {
  commitTextEditor();
  E.tool = tool;
  for (const t of ["pen", "highlighter", "eraser", "lasso", "shape", "text", "image", "select", "hand"]) {
    $("tool-" + t).classList.toggle("selected", t === tool);
  }
  $("shape-options").style.display = tool === "shape" ? "" : "none";
  $("pen-options").style.display = tool === "pen" ? "" : "none";
  $("hl-options").style.display = tool === "highlighter" ? "" : "none";
  $("color-row").style.display = tool === "highlighter" ? "none" : ""; // 형광펜은 전용 색만
  if (tool !== "select" && tool !== "lasso") clearSelection();
}

function bindToolbar() {
  for (const t of ["pen", "highlighter", "eraser", "lasso", "shape", "text", "select", "hand"]) {
    $("tool-" + t).addEventListener("click", () => setTool(t));
  }
  $("pen-options").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    E.penStyle = b.dataset.p;
    document.querySelectorAll("#pen-options button").forEach((x) => x.classList.toggle("selected", x === b));
    savePrefs();
  });
  // 형광펜 전용 색 / 직선 보정
  $("hl-options").style.display = "none";
  $("hl-options").addEventListener("click", (e) => {
    const b = e.target.closest("button.hl-col"); if (!b) return;
    E.hlColor = b.dataset.h;
    document.querySelectorAll("#hl-options .hl-col").forEach((x) => x.classList.toggle("selected", x === b));
    savePrefs();
  });
  $("hl-straight").addEventListener("change", (e) => { E.hlStraight = e.target.checked; savePrefs(); });
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
    savePrefs();
  });
  $("color-custom").addEventListener("input", (e) => {
    E.color = e.target.value;
    document.querySelectorAll("#color-row .col").forEach((x) => x.classList.remove("selected"));
    savePrefs();
  });

  $("size-slider").addEventListener("input", (e) => {
    E.size = Number(e.target.value);
    $("size-label").textContent = E.size;
    syncSizeDots();
    savePrefs();
  });
  // 펜 세부 설정 팝오버 (⊙)
  const settingsMenu = $("settings-menu");
  $("btn-tool-settings").addEventListener("click", (e) => {
    e.stopPropagation();
    settingsMenu.classList.toggle("hidden");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!settingsMenu.classList.contains("hidden") && !settingsMenu.contains(e.target) && e.target.id !== "btn-tool-settings") {
      settingsMenu.classList.add("hidden");
    }
  });

  // 굵기 프리셋 (얇게/중간/굵게)
  $("size-presets").addEventListener("click", (e) => {
    const b = e.target.closest("button.size-dot"); if (!b) return;
    E.size = Number(b.dataset.s);
    $("size-slider").value = E.size;
    $("size-label").textContent = E.size;
    syncSizeDots();
    savePrefs();
  });
  syncSizeDots();
  $("finger-draw").addEventListener("change", (e) => { E.fingerDraw = e.target.checked; savePrefs(); });
  $("scribble-erase").addEventListener("change", (e) => { E.scribble = e.target.checked; savePrefs(); });

  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  // 제목을 탭하면 이름 바꾸기
  $("editor-title").addEventListener("click", () => {
    if (E.nb) openRenameNotebook(E.nb, (t) => { $("editor-title").textContent = t; });
  });
  $("btn-back").addEventListener("click", () => {
    commitTextEditor(); flushSave();
    if (E.rec) stopRecording();
    stopPlayback();
    $("audio-panel").classList.add("hidden");
    showScreen("shelf");
    E.nb = null;
  });

  // 선택 상자: 삭제 / 크기 조절
  $("sel-delete").addEventListener("click", () => {
    if (E.lasso) { deleteLassoSelection(); return; }
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
  menuDo("menu-insert-pdf", () => $("input-pdf-insert").click());
  $("input-pdf-insert").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) insertPdf(f);
  });
  $("page-search").addEventListener("input", (e) => {
    E.pageFilter = e.target.value.trim().toLowerCase();
    renderPagePanel();
  });
  menuDo("menu-export-pdf", exportPdf);
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

// ============================================================
//  음성 녹음 — 녹음하며 필기, 동기화 재생 (굿노트 스타일)
// ============================================================
const REC_MAX_SEC = 30 * 60;   // 최대 30분 자동 정지
const AUDIO_CHUNK = 500000;

function audioCol(pageId) {
  const { fs } = ctx.fb;
  return fs.collection(fs.doc(pageCol(), pageId), "audio");
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// ---------- 녹음 ----------
async function toggleRecording() {
  if (E.rec) { stopRecording(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("이 브라우저에서는 녹음을 지원하지 않아요");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const { fs } = ctx.fb;
    const recId = fs.doc(audioCol(curPage().id)).id;
    const rec = { mr, stream, chunks: [], t0: Date.now(), pageId: curPage().id, recId };
    mr.addEventListener("dataavailable", (e) => { if (e.data.size) rec.chunks.push(e.data); });
    mr.start(1000);
    E.rec = rec;

    $("btn-record").textContent = "⏹";
    $("rec-timer").classList.remove("hidden");
    rec.timer = setInterval(() => {
      const sec = (Date.now() - rec.t0) / 1000;
      $("rec-timer").textContent = "● " + fmtTime(sec);
      if (sec >= REC_MAX_SEC) { toast("30분이 되어 녹음을 저장했어요"); stopRecording(); }
    }, 1000);
    toast("🎙 녹음 시작 — 필기하면 재생할 때 함께 나타나요");
  } catch (e) {
    console.error(e);
    toast(e.name === "NotAllowedError" ? "마이크 사용 권한을 허용해 주세요" : "녹음을 시작하지 못했어요: " + (e.message || e));
  }
}

function stopRecording() {
  const rec = E.rec;
  if (!rec) return;
  E.rec = null;
  clearInterval(rec.timer);
  $("btn-record").textContent = "🎙";
  $("rec-timer").classList.add("hidden");
  const dur = Math.round((Date.now() - rec.t0) / 100) / 10;

  rec.mr.addEventListener("stop", async () => {
    rec.stream.getTracks().forEach((t) => t.stop());
    if (dur < 1 || rec.chunks.length === 0) { toast("녹음이 너무 짧아 저장하지 않았어요"); return; }
    try {
      setStatus("녹음 저장 중…");
      const blob = new Blob(rec.chunks, { type: rec.mr.mimeType || "audio/webm" });
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      const { fs } = ctx.fb;
      const now = new Date();
      const metaRef = fs.doc(audioCol(rec.pageId), rec.recId);
      await fs.setDoc(metaRef, {
        dur, mime: blob.type, total: Math.ceil(dataUrl.length / AUDIO_CHUNK),
        label: `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
        createdAt: fs.serverTimestamp(),
      });
      for (let c = 0; c * AUDIO_CHUNK < dataUrl.length; c++) {
        await fs.setDoc(fs.doc(fs.collection(metaRef, "chunks"), String(c)), {
          i: c, data: dataUrl.slice(c * AUDIO_CHUNK, (c + 1) * AUDIO_CHUNK),
        });
      }
      const p = E.pages.find((x) => x.id === rec.pageId);
      if (p) p.audioList = null; // 목록 다시 불러오게
      setStatus("저장됨 ✓");
      toast(`녹음 저장 완료 (${fmtTime(dur)}) — 🎧에서 재생할 수 있어요`);
    } catch (e) {
      console.error(e);
      setStatus("저장 실패");
      toast("녹음 저장에 실패했어요: " + (e.message || e));
    }
  }, { once: true });
  rec.mr.stop();
}

// ---------- 녹음 목록 ----------
async function loadAudioList(p) {
  if (p.audioList) return p.audioList;
  const { fs } = ctx.fb;
  const snap = await fs.getDocs(audioCol(p.id));
  p.audioList = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  return p.audioList;
}

async function openAudioPanel() {
  const panel = $("audio-panel");
  panel.classList.remove("hidden");
  const list = $("audio-list");
  list.innerHTML = "<p class='audio-empty'>불러오는 중…</p>";
  try {
    const items = await loadAudioList(curPage());
    list.innerHTML = "";
    if (items.length === 0) {
      list.innerHTML = "<p class='audio-empty'>아직 녹음이 없어요.<br/>🎙 버튼으로 녹음해 보세요.</p>";
      return;
    }
    items.forEach((m, idx) => {
      const row = document.createElement("div");
      row.className = "audio-item";
      const play = document.createElement("button");
      play.className = "icon-btn";
      play.textContent = "▶";
      play.addEventListener("click", () => { panel.classList.add("hidden"); playRecording(m); });
      const info = document.createElement("div");
      info.className = "audio-info";
      info.innerHTML = `<strong>녹음 ${idx + 1}</strong><span>${m.label || ""} · ${fmtTime(m.dur || 0)}</span>`;
      const tr = document.createElement("button");
      tr.className = "icon-btn";
      tr.title = "AI 전사(받아쓰기)";
      tr.textContent = "📝";
      tr.addEventListener("click", () => { panel.classList.add("hidden"); transcribeRecording(m); });
      const del = document.createElement("button");
      del.className = "icon-btn";
      del.textContent = "🗑";
      del.addEventListener("click", async () => {
        if (!confirm("이 녹음을 삭제할까요?")) return;
        await deleteRecording(curPage(), m.id);
        openAudioPanel();
      });
      row.append(play, info, tr, del);
      list.appendChild(row);
    });
  } catch (e) {
    console.error(e);
    list.innerHTML = "<p class='audio-empty'>목록을 불러오지 못했어요</p>";
  }
}

async function deleteRecording(p, recId) {
  try {
    const { fs } = ctx.fb;
    const metaRef = fs.doc(audioCol(p.id), recId);
    const chunks = await fs.getDocs(fs.collection(metaRef, "chunks"));
    for (const c of chunks.docs) await fs.deleteDoc(c.ref);
    await fs.deleteDoc(metaRef);
    p.audioList = null;
    if (E.player?.recId === recId) stopPlayback();
    toast("삭제했어요");
  } catch (e) {
    console.error(e);
    toast("삭제에 실패했어요: " + (e.message || e));
  }
}

async function fetchAudioData(p, meta) {
  const { fs } = ctx.fb;
  const metaRef = fs.doc(audioCol(p.id), meta.id);
  const snap = await fs.getDocs(fs.collection(metaRef, "chunks"));
  if (snap.empty) throw new Error("녹음 데이터를 찾을 수 없어요");
  const dataUrl = snap.docs.map((d) => d.data()).sort((a, b) => a.i - b.i).map((c) => c.data).join("");
  return dataUrl;
}

// ---------- 재생 (필기 동기화) ----------
async function playRecording(meta) {
  try {
    stopPlayback();
    aiProgress(true, "녹음을 불러오는 중…");
    const p = curPage();
    const dataUrl = await fetchAudioData(p, meta);
    // data URL → Blob URL (사파리 호환)
    const [head, b64] = dataUrl.split(",");
    const mime = head.match(/data:(.*?);/)?.[1] || meta.mime || "audio/webm";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    aiProgress(false);

    const audio = new Audio(url);
    E.player = { audio, url, recId: meta.id, dur: meta.dur || 0, time: 0, speed: 1, raf: null };
    $("player-bar").classList.remove("hidden");
    $("player-seek").max = E.player.dur;
    $("player-toggle").textContent = "⏸";
    $("player-speed").textContent = "1×";
    audio.addEventListener("ended", () => { $("player-toggle").textContent = "▶"; });
    // iOS: 로딩이 끝난 시점엔 '사용자 탭' 컨텍스트가 끊겨 자동 재생이 거부될 수 있음
    try {
      await audio.play();
    } catch {
      $("player-toggle").textContent = "▶";
      toast("준비됐어요 — ▶ 버튼을 눌러 재생하세요");
    }
    playerTick();
    const hasSync = p.strokes.some((st) => st.rid === meta.id);
    if (hasSync) toast("✋ 손 도구로 필기를 탭하면 그 시점으로 이동해요");
  } catch (e) {
    console.error(e);
    aiProgress(false);
    toast("재생에 실패했어요: " + (e.message || e));
  }
}

function playerTick() {
  if (!E.player) return;
  const pl = E.player;
  const t = pl.audio.currentTime;
  if (Math.abs(t - pl.time) > 0.15) {
    pl.time = t;
    $("player-seek").value = t;
    $("player-time").textContent = `${fmtTime(t)} / ${fmtTime(pl.dur)}`;
    redrawInk(); // 필기 동기화(고스트) 갱신
  }
  pl.raf = requestAnimationFrame(playerTick);
}

function stopPlayback() {
  const pl = E.player;
  if (!pl) return;
  E.player = null;
  cancelAnimationFrame(pl.raf);
  pl.audio.pause();
  URL.revokeObjectURL(pl.url);
  $("player-bar").classList.add("hidden");
  redrawInk();
}

// 재생 중 ✋ 손 도구로 필기를 탭 → 그 획을 쓴 시점으로 이동
function seekToStrokeAt(pt) {
  if (!E.player) return false;
  const p = curPage();
  let best = null, bestD = 20;
  for (const st of p.strokes) {
    if (st.rid !== E.player.recId || st.rt == null) continue;
    for (const [x, y] of strokePoints(st)) {
      const d = Math.hypot(x - pt.x, y - pt.y);
      if (d < bestD) { bestD = d; best = st; }
    }
  }
  if (best) {
    E.player.audio.currentTime = Math.max(0, best.rt - 1);
    if (E.player.audio.paused) { E.player.audio.play(); $("player-toggle").textContent = "⏸"; }
    return true;
  }
  return false;
}

function bindAudio() {
  $("btn-record").addEventListener("click", toggleRecording);
  $("btn-audio").addEventListener("click", () => {
    if ($("audio-panel").classList.contains("hidden")) openAudioPanel();
    else $("audio-panel").classList.add("hidden");
  });
  $("audio-panel-close").addEventListener("click", () => $("audio-panel").classList.add("hidden"));

  $("player-toggle").addEventListener("click", () => {
    if (!E.player) return;
    const a = E.player.audio;
    if (a.paused) { a.play(); $("player-toggle").textContent = "⏸"; }
    else { a.pause(); $("player-toggle").textContent = "▶"; }
  });
  $("player-seek").addEventListener("input", (e) => {
    if (E.player) E.player.audio.currentTime = Number(e.target.value);
  });
  $("player-speed").addEventListener("click", () => {
    if (!E.player) return;
    const next = { 1: 1.5, 1.5: 2, 2: 1 }[E.player.speed] || 1;
    E.player.speed = next;
    E.player.audio.playbackRate = next;
    $("player-speed").textContent = next + "×";
  });
  $("player-close").addEventListener("click", stopPlayback);
}

// ============================================================
//  AI 도구 — 손글씨 인식(Google Input Tools) + Gemini(요약·퀴즈·다듬기)
// ============================================================
const HW_URL = "https://inputtools.google.com/request?itc=ko-t-i0-handwrit&app=ssamnote";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_KEY_STORAGE = "ssamnote_gemini_key";
let aiReplaceCtx = null; // '필기를 텍스트로 교체'용 {strokeIdxs, bbox}

// 펜 획들을 Google 필기 인식으로 → 텍스트
async function recognizeInk(strokes, w, h) {
  const pen = strokes.filter((st) => st.t === "pen" && st.p && st.p.length);
  if (pen.length === 0) throw new Error("인식할 펜 필기가 없어요 (형광펜·도형은 제외돼요)");
  const ink = pen.map((st) => [st.p.map((q) => Math.round(q[0])), st.p.map((q) => Math.round(q[1]))]);
  const res = await fetch(HW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      options: "enable_pre_space",
      requests: [{
        writing_guide: { writing_area_width: Math.round(w), writing_area_height: Math.round(h) },
        ink, language: "ko",
      }],
    }),
  });
  if (!res.ok) throw new Error("인식 서버에 연결하지 못했어요 (" + res.status + ")");
  const j = await res.json();
  if (j[0] !== "SUCCESS" || !j[1]?.[0]?.[1]?.length) throw new Error("필기를 인식하지 못했어요");
  return j[1][0][1][0];
}

// 페이지에서 AI에 넘길 텍스트 수집: 손글씨 인식 결과 + 텍스트 상자
async function getPageText() {
  const p = curPage();
  let hand = "";
  try {
    if (p.strokes.some((st) => st.t === "pen")) hand = await recognizeInk(p.strokes, p.w, p.h);
  } catch { /* 손글씨가 없거나 인식 실패해도 텍스트 상자만으로 진행 */ }
  const typed = p.objects.filter((o) => o.type === "text").map((o) => o.text).join("\n");
  return [hand, typed].filter(Boolean).join("\n");
}

function aiProgress(show, text = "") {
  $("modal-progress").classList.toggle("hidden", !show);
  if (show) {
    $("progress-title").textContent = "AI 작업 중…";
    $("progress-text").textContent = text;
    $("progress-bar").style.width = "100%";
  }
}

function openAiModal(title, text, canReplace = false) {
  $("ai-title").textContent = title;
  $("ai-result").value = text;
  $("ai-replace").classList.toggle("hidden", !canReplace);
  $("modal-ai").classList.remove("hidden");
}

// ---------- Gemini ----------
let keyResolver = null;

function ensureGeminiKey() {
  const saved = localStorage.getItem(GEMINI_KEY_STORAGE);
  if (saved) return Promise.resolve(saved);
  return openKeyModal();
}

function openKeyModal() {
  $("key-input").value = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  $("modal-key").classList.remove("hidden");
  return new Promise((res) => { keyResolver = res; });
}

function closeKeyModal(value) {
  $("modal-key").classList.add("hidden");
  if (keyResolver) { keyResolver(value); keyResolver = null; }
}

async function askGemini(key, prompt, audio = null) {
  const parts = [{ text: prompt }];
  if (audio) parts.push({ inline_data: { mime_type: audio.mime, data: audio.b64 } });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  if (res.status === 400 || res.status === 403) {
    throw new Error("API 키가 올바르지 않아요. ✨ 메뉴의 'AI 설정'에서 다시 입력해 주세요.");
  }
  if (!res.ok) throw new Error("AI 서버 오류 (" + res.status + ")");
  const j = await res.json();
  const out = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!out) throw new Error("AI가 답을 만들지 못했어요. 다시 시도해 주세요.");
  return out;
}

const AI_PROMPTS = {
  summarize: {
    title: "AI 요약·정리",
    make: (t) => `다음은 교사의 수업 필기 내용입니다. 한국어로 핵심을 간결하게 요약하고, 중요한 개념을 항목별로 정리해 주세요. 손글씨 인식 과정에서 생긴 오탈자는 문맥에 맞게 바로잡아 주세요.\n\n${t}`,
  },
  quiz: {
    title: "AI 퀴즈",
    make: (t) => `다음 수업 필기 내용을 바탕으로 학생용 확인 문제 5개를 한국어로 만들어 주세요. 다양한 유형(객관식, 단답형, OX)을 섞고, 마지막에 정답과 간단한 해설을 모아서 적어 주세요.\n\n${t}`,
  },
  polish: {
    title: "AI 글 다듬기",
    make: (t) => `다음 글의 맞춤법과 띄어쓰기를 교정하고 문장을 자연스럽게 다듬어 주세요. 내용은 바꾸지 말고, 다듬은 글만 출력해 주세요.\n\n${t}`,
  },
};

async function runAiAction(kind) {
  try {
    const key = await ensureGeminiKey();
    if (!key) return; // 취소
    aiProgress(true, "필기를 읽는 중…");
    const text = await getPageText();
    if (!text.trim()) {
      aiProgress(false);
      toast("이 페이지에 읽을 수 있는 필기·텍스트가 없어요");
      return;
    }
    aiProgress(true, "AI가 생각하는 중…");
    const cfg = AI_PROMPTS[kind];
    const out = await askGemini(key, cfg.make(text));
    aiProgress(false);
    aiReplaceCtx = null;
    openAiModal(cfg.title, out, false);
  } catch (e) {
    console.error(e);
    aiProgress(false);
    toast(e.message || String(e));
  }
}

async function runRecognize(selectionOnly) {
  try {
    const p = curPage();
    let strokes, bbox;
    if (selectionOnly) {
      if (!E.lasso || E.lasso.strokeIdxs.length === 0) {
        toast("⭕ 올가미 도구로 변환할 필기를 먼저 둘러 주세요");
        return;
      }
      strokes = E.lasso.strokeIdxs.map((i) => p.strokes[i]);
      bbox = { ...E.lasso.bbox };
      aiReplaceCtx = { strokeIdxs: [...E.lasso.strokeIdxs], bbox };
    } else {
      strokes = p.strokes;
      bbox = null;
      aiReplaceCtx = null;
    }
    aiProgress(true, "손글씨를 인식하는 중…");
    const text = await recognizeInk(strokes, p.w, p.h);
    aiProgress(false);
    openAiModal("손글씨 → 텍스트", text, selectionOnly);
  } catch (e) {
    console.error(e);
    aiProgress(false);
    toast(e.message || String(e));
  }
}

// 녹음 → AI 전사(받아쓰기)
async function transcribeRecording(meta) {
  try {
    const key = await ensureGeminiKey();
    if (!key) return;
    aiProgress(true, "녹음을 불러오는 중…");
    const dataUrl = await fetchAudioData(curPage(), meta);
    const [head, b64] = dataUrl.split(",");
    const mime = head.match(/data:(.*?);/)?.[1] || meta.mime || "audio/webm";
    if (b64.length > 19000000) throw new Error("녹음이 너무 길어요 (약 20MB 초과)");
    aiProgress(true, "AI가 받아쓰는 중… (길면 1분 정도 걸려요)");
    const out = await askGemini(key,
      "다음 녹음을 한국어로 전사해 주세요. 문장 단위로 자연스럽게 정리하고, 화자가 바뀌면 줄을 바꿔 주세요. 전사문만 출력하세요.",
      { mime, b64 });
    aiProgress(false);
    aiReplaceCtx = null;
    openAiModal(`녹음 전사 (${fmtTime(meta.dur || 0)})`, out, false);
  } catch (e) {
    console.error(e);
    aiProgress(false);
    toast(e.message || String(e));
  }
}

function bindAi() {
  const menu = $("ai-menu");
  $("btn-ai").addEventListener("click", (e) => {
    e.stopPropagation();
    $("page-menu").classList.add("hidden");
    menu.classList.toggle("hidden");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target.id !== "btn-ai") {
      menu.classList.add("hidden");
    }
  });
  const menuDo = (id, fn) => $(id).addEventListener("click", () => { menu.classList.add("hidden"); fn(); });
  menuDo("ai-recognize-sel", () => runRecognize(true));
  menuDo("ai-recognize-page", () => runRecognize(false));
  menuDo("ai-summarize", () => runAiAction("summarize"));
  menuDo("ai-quiz", () => runAiAction("quiz"));
  menuDo("ai-polish", () => runAiAction("polish"));
  menuDo("ai-settings", openKeyModal);

  // 결과 모달
  $("ai-close").addEventListener("click", () => $("modal-ai").classList.add("hidden"));
  $("ai-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("ai-result").value);
      toast("복사했어요");
    } catch {
      toast("복사에 실패했어요 — 텍스트를 직접 선택해 주세요");
    }
  });
  $("ai-add-text").addEventListener("click", () => {
    const text = $("ai-result").value.trim();
    if (!text) return;
    const p = curPage();
    const pos = aiReplaceCtx?.bbox
      ? { x: aiReplaceCtx.bbox.x, y: aiReplaceCtx.bbox.y }
      : { x: 60, y: 60 };
    const o = {
      type: "text", x: pos.x, y: pos.y,
      w: Math.min(p.w - pos.x - 40, 600), text, fs: 18, color: "#1a1a1a",
    };
    commit(() => p.objects.push(o));
    $("modal-ai").classList.add("hidden");
    toast("텍스트 상자를 추가했어요");
  });
  $("ai-replace").addEventListener("click", () => {
    const text = $("ai-result").value.trim();
    if (!aiReplaceCtx || !text) return;
    const { strokeIdxs, bbox } = aiReplaceCtx;
    const p = curPage();
    commit(() => {
      // 선택된 펜 획만 제거하고 그 자리에 텍스트 상자
      for (const i of [...strokeIdxs].sort((a, b) => b - a)) {
        if (p.strokes[i]?.t === "pen") p.strokes.splice(i, 1);
      }
      p.objects.push({
        type: "text", x: bbox.x + 6, y: bbox.y + 6,
        w: Math.max(200, bbox.w), text, fs: 20, color: "#1a1a1a",
      });
    });
    clearSelection();
    $("modal-ai").classList.add("hidden");
    toast("필기를 텍스트로 바꿨어요");
  });

  // API 키 모달
  $("key-save").addEventListener("click", () => {
    const v = $("key-input").value.trim();
    if (v) localStorage.setItem(GEMINI_KEY_STORAGE, v);
    closeKeyModal(v || null);
  });
  $("key-cancel").addEventListener("click", () => closeKeyModal(null));
  $("key-clear").addEventListener("click", () => {
    localStorage.removeItem(GEMINI_KEY_STORAGE);
    $("key-input").value = "";
    toast("저장된 키를 지웠어요");
  });
}

// ---------- 유틸 ----------
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
function rgbToHex(c) { return c.startsWith("#") ? c : "#1a1a1a"; }
