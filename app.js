// ============================================================
//  수업필기 — 앱 셸
//  로그인 / 책장(노트북 목록) / 새 노트북 / PDF 가져오기
//  실제 필기 화면은 editor.js 가 담당합니다.
// ============================================================

import { firebaseConfig, APP_NAME } from "./config.js";
import { initEditor, openNotebook } from "./editor.js";

const $ = (id) => document.getElementById(id);

// ---------- 전역 상태 ----------
export const ctx = {
  fb: null,       // { auth, db, authMod, fs }
  user: null,
  notebooks: [],
};

// ---------- 토스트 ----------
let toastTimer = null;
export function toast(msg, ms = 2500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// ---------- 화면 전환 ----------
export function showScreen(name) {
  for (const s of ["login", "shelf", "editor"]) {
    $("screen-" + s).classList.toggle("hidden", s !== name);
  }
}

// ---------- Firebase 초기화 ----------
async function initFirebase() {
  const appMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const authMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const fs = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  const app = appMod.initializeApp(firebaseConfig);
  // 오프라인에서도 열람/필기 가능하도록 로컬 캐시 사용
  let db;
  try {
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentSingleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  ctx.fb = { auth: authMod.getAuth(app), db, authMod, fs };

  authMod.onAuthStateChanged(ctx.fb.auth, (user) => {
    ctx.user = user;
    if (user) {
      $("shelf-user").textContent = user.email || "";
      showScreen("shelf");
      watchNotebooks();
    } else {
      showScreen("login");
    }
  });

  // 리디렉션 로그인 복귀 처리(팝업이 막힌 태블릿 브라우저 대비)
  authMod.getRedirectResult(ctx.fb.auth).catch(() => {});
}

// ---------- 로그인 / 로그아웃 ----------
async function login() {
  const { authMod, auth } = ctx.fb;
  const provider = new authMod.GoogleAuthProvider();
  $("login-error").classList.add("hidden");
  try {
    await authMod.signInWithPopup(auth, provider);
  } catch (e) {
    // 팝업 차단/미지원 환경(일부 태블릿 PWA)에서는 리디렉션 방식으로 재시도
    if (["auth/popup-blocked", "auth/popup-closed-by-user", "auth/cancelled-popup-request",
         "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
      try { await authMod.signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
    }
    const el = $("login-error");
    el.textContent = "로그인에 실패했어요: " + (e.message || e);
    el.classList.remove("hidden");
  }
}

// ---------- 노트북 목록 ----------
let unsubNotebooks = null;

function nbCol() {
  const { fs, db } = ctx.fb;
  return fs.collection(db, "users", ctx.user.uid, "notebooks");
}
export function pageCol() {
  const { fs, db } = ctx.fb;
  return fs.collection(db, "users", ctx.user.uid, "pages");
}

function watchNotebooks() {
  const { fs } = ctx.fb;
  if (unsubNotebooks) unsubNotebooks();
  const q = fs.query(nbCol(), fs.orderBy("updatedAt", "desc"));
  unsubNotebooks = fs.onSnapshot(q, (snap) => {
    ctx.notebooks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderShelf();
  }, (err) => {
    console.error(err);
    toast("노트북 목록을 불러오지 못했어요: " + err.code);
  });
}

let shelfFilter = "";

function renderShelf() {
  const grid = $("shelf-grid");
  grid.innerHTML = "";
  const list = shelfFilter
    ? ctx.notebooks.filter((nb) => (nb.title || "").toLowerCase().includes(shelfFilter))
    : ctx.notebooks;
  $("shelf-empty").classList.toggle("hidden", list.length > 0);
  $("shelf-empty").querySelector("p").innerHTML = shelfFilter
    ? "검색 결과가 없어요."
    : "아직 노트북이 없어요.<br/>아래 버튼으로 첫 노트북을 만들어 보세요!";

  for (const nb of list) {
    // 굿노트풍 표지: 색 표지 + 제본 홈 + 흰 라벨
    const card = document.createElement("div");
    card.className = "nb-card";
    card.style.setProperty("--c", nb.color || "#2f6bff");

    const label = document.createElement("div");
    label.className = "nb-label";
    label.textContent = nb.title || "제목 없음";

    const meta = document.createElement("div");
    meta.className = "nb-meta";
    meta.textContent = `${nb.pageCount || 1}쪽`;

    const more = document.createElement("button");
    more.className = "nb-more";
    more.textContent = "⋮";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      notebookMenu(nb);
    });

    card.append(label, meta, more);
    card.addEventListener("click", () => openNotebook(nb));
    grid.appendChild(card);
  }
}

// ---------- 노트북 메뉴 / 이름 바꾸기 ----------
let menuTarget = null;
let renameTarget = null;
let renameCallback = null;

function notebookMenu(nb) {
  menuTarget = nb;
  $("nbmenu-title").textContent = nb.title || "제목 없음";
  $("modal-nbmenu").classList.remove("hidden");
}

export function openRenameNotebook(nb, cb = null) {
  renameTarget = nb;
  renameCallback = cb;
  $("rename-input").value = nb.title || "";
  $("modal-rename").classList.remove("hidden");
  setTimeout(() => { $("rename-input").focus(); $("rename-input").select(); }, 60);
}

async function saveRename() {
  const t = $("rename-input").value.trim();
  $("modal-rename").classList.add("hidden");
  if (!renameTarget || !t || t === renameTarget.title) return;
  try {
    const { fs, db } = ctx.fb;
    await fs.updateDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", renameTarget.id), {
      title: t, updatedAt: fs.serverTimestamp(),
    });
    renameTarget.title = t;
    if (renameCallback) renameCallback(t);
    toast("이름을 바꿨어요");
  } catch (e) {
    console.error(e);
    toast("이름 변경에 실패했어요: " + (e.message || e));
  }
}

async function deleteNotebook(nb) {
  const { fs, db } = ctx.fb;
  const q = fs.query(pageCol(), fs.where("nb", "==", nb.id));
  const snap = await fs.getDocs(q);
  for (const d of snap.docs) {
    // 배경 이미지·녹음 조각도 함께 삭제
    const bgSnap = await fs.getDocs(fs.collection(d.ref, "bg"));
    for (const c of bgSnap.docs) await fs.deleteDoc(c.ref);
    const audioSnap = await fs.getDocs(fs.collection(d.ref, "audio"));
    for (const a of audioSnap.docs) {
      const chunks = await fs.getDocs(fs.collection(a.ref, "chunks"));
      for (const c of chunks.docs) await fs.deleteDoc(c.ref);
      await fs.deleteDoc(a.ref);
    }
    await fs.deleteDoc(d.ref);
  }
  await fs.deleteDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", nb.id));
}

// ---------- 새 노트북 ----------
function newNotebookModal(show) {
  $("modal-new").classList.toggle("hidden", !show);
  if (show) { $("new-nb-title").value = ""; $("new-nb-title").focus(); }
}

async function createNotebook() {
  const title = $("new-nb-title").value.trim() || "새 노트북";
  const template = document.querySelector("#new-nb-template .selected").dataset.t;
  const color = document.querySelector("#new-nb-color .selected").dataset.c;

  const { fs } = ctx.fb;
  const nbRef = fs.doc(nbCol());
  await fs.setDoc(nbRef, {
    title, color, template, pageCount: 1,
    createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp(),
  });
  // 첫 페이지
  const pRef = fs.doc(pageCol());
  await fs.setDoc(pRef, {
    nb: nbRef.id, order: 0, template, w: 1000, h: 1414,
    hasBg: false, strokes: "[]", objects: "[]", updatedAt: fs.serverTimestamp(),
  });
  newNotebookModal(false);
  openNotebook({ id: nbRef.id, title, color, template, pageCount: 1 });
}

// ---------- PDF 가져오기 ----------
const PDF_JS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs";
const PDF_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
const CHUNK = 500000; // Firestore 문서 1MB 제한 대비 배경 이미지 조각 크기

function progress(show, title = "", text = "", ratio = 0) {
  $("modal-progress").classList.toggle("hidden", !show);
  if (show) {
    $("progress-title").textContent = title;
    $("progress-text").textContent = text;
    $("progress-bar").style.width = Math.round(ratio * 100) + "%";
  }
}

// PDF를 페이지 단위로 렌더링(배경 이미지 + 텍스트 추출) — 새 노트/삽입 공용
export async function renderPdfPages(file, onPage) {
  const pdfjs = await import(PDF_JS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const n = pdf.numPages;
  const canvas = document.createElement("canvas");
  const cx = canvas.getContext("2d");

  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = 1536 / vp1.width;
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: cx, viewport: vp }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

    // 페이지 텍스트 추출 (노트 내 검색용)
    let text = "";
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((t) => t.str).join(" ").replace(/\s+/g, " ").trim().slice(0, 4000);
    } catch { /* 텍스트 없는 스캔 PDF 등 */ }

    await onPage({
      i, n, dataUrl, text,
      w: 1000, h: Math.round(1000 * vp1.height / vp1.width),
    });
    page.cleanup();
  }
  return n;
}

// 페이지 문서 + 배경 조각 저장
export async function writePdfPage(nbId, order, pg) {
  const { fs } = ctx.fb;
  const pRef = fs.doc(pageCol());
  await fs.setDoc(pRef, {
    nb: nbId, order, template: "blank", w: pg.w, h: pg.h,
    hasBg: true, text: pg.text || "", strokes: "[]", objects: "[]",
    updatedAt: fs.serverTimestamp(),
  });
  for (let c = 0; c * CHUNK < pg.dataUrl.length; c++) {
    await fs.setDoc(fs.doc(fs.collection(pRef, "bg"), String(c)), {
      i: c, total: Math.ceil(pg.dataUrl.length / CHUNK),
      data: pg.dataUrl.slice(c * CHUNK, (c + 1) * CHUNK),
    });
  }
  return pRef.id;
}

async function importPdf(file) {
  try {
    progress(true, "PDF 여는 중…", file.name, 0);
    const { fs } = ctx.fb;
    const title = file.name.replace(/\.pdf$/i, "");
    let nbRef = null;
    const n = await renderPdfPages(file, async (pg) => {
      if (!nbRef) {
        nbRef = fs.doc(nbCol());
        await fs.setDoc(nbRef, {
          title, color: "#475569", template: "blank", pageCount: pg.n,
          createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp(),
        });
      }
      progress(true, "PDF 가져오는 중…", `${pg.i} / ${pg.n} 페이지`, (pg.i - 1) / pg.n);
      await writePdfPage(nbRef.id, pg.i - 1, pg);
    });
    progress(false);
    toast(`"${title}" 가져오기 완료 (${n}쪽)`);
  } catch (e) {
    console.error(e);
    progress(false);
    toast("PDF 가져오기에 실패했어요: " + (e.message || e));
  }
}

// ---------- 이벤트 연결 ----------
function bindEvents() {
  $("btn-login").addEventListener("click", login);
  $("btn-logout").addEventListener("click", () => ctx.fb.authMod.signOut(ctx.fb.auth));

  $("btn-new-notebook").addEventListener("click", () => newNotebookModal(true));
  $("btn-new-cancel").addEventListener("click", () => newNotebookModal(false));
  $("btn-new-create").addEventListener("click", () =>
    createNotebook().catch((e) => { console.error(e); toast("만들기에 실패했어요: " + e.message); })
  );

  // 템플릿/색상 선택
  for (const sel of ["new-nb-template", "new-nb-color"]) {
    $(sel).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $(sel).querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
    });
  }

  // 노트북 메뉴 / 이름 바꾸기
  $("nbmenu-cancel").addEventListener("click", () => $("modal-nbmenu").classList.add("hidden"));
  $("nbmenu-rename").addEventListener("click", () => {
    $("modal-nbmenu").classList.add("hidden");
    if (menuTarget) openRenameNotebook(menuTarget);
  });
  $("nbmenu-delete").addEventListener("click", async () => {
    $("modal-nbmenu").classList.add("hidden");
    if (!menuTarget) return;
    if (!confirm(`"${menuTarget.title}" 노트북과 모든 페이지를 삭제할까요?\n되돌릴 수 없어요.`)) return;
    try {
      await deleteNotebook(menuTarget);
      toast("삭제했어요");
    } catch (e) {
      console.error(e);
      toast("삭제에 실패했어요: " + (e.message || e));
    }
  });
  $("rename-cancel").addEventListener("click", () => $("modal-rename").classList.add("hidden"));
  $("rename-save").addEventListener("click", saveRename);
  $("rename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveRename();
    if (e.key === "Escape") $("modal-rename").classList.add("hidden");
  });

  $("shelf-search").addEventListener("input", (e) => {
    shelfFilter = e.target.value.trim().toLowerCase();
    renderShelf();
  });

  $("btn-new-pdf").addEventListener("click", () => $("input-pdf").click());
  $("input-pdf").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importPdf(f);
  });
}

// ---------- 시작 ----------
async function main() {
  bindEvents();
  initEditor();

  // 개발용 데모 모드: #demo 로 열면 로그인 없이 임시 노트북(저장 안 됨)
  if (location.hash === "#demo") {
    let seq = 0;
    ctx.user = { uid: "demo", email: "demo@local" };
    ctx.fb = {
      authMod: { signOut: () => {} },
      fs: {
        query: () => null, where: () => null, orderBy: () => null,
        collection: () => null,
        doc: (_c, id) => ({ id: id || "demo-p" + (++seq) }),
        getDocs: async () => ({ docs: [], empty: true }),
        setDoc: async () => {}, updateDoc: async () => {}, deleteDoc: async () => {},
        serverTimestamp: () => Date.now(),
      },
    };
    showScreen("shelf");
    openNotebook({ id: "demo-nb", title: "데모 노트북", color: "#4a6cf7", template: "lines", pageCount: 1 });
    return;
  }

  await initFirebase();

  // PWA 서비스 워커
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  toast("앱 시작에 실패했어요: " + (e.message || e));
});
