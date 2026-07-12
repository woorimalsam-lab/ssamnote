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
  folders: [],
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
      watchFolders();
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

// ---------- 기능 안내 스트립 (메인 화면) ----------
const FEATURES = [
  { icon: "🖊", name: "필압 펜", desc: "펜 도구를 고르면 옆에 '만년필 / 볼펜' 버튼이 나타나요.\n\n• 만년필: 펜슬을 누르는 세기에 따라 굵기가 살아나는 손글씨 느낌\n• 볼펜: 항상 일정한 굵기\n\n색상과 굵기 슬라이더는 바로 옆에 있고, 마지막 설정은 자동으로 기억돼요." },
  { icon: "🧽", name: "긁적 지우기", desc: "지우개로 바꿀 필요 없이, 펜으로 틀린 부분 위를 쓱쓱 지그재그로 문지르면 그 아래 필기가 지워져요.\n\n빈 곳에 그린 지그재그는 평범한 필기로 남아요. 실수로 지워졌다면 ↩ 되돌리기를 누르세요.\n\n도구바 오른쪽 '긁적 지우기' 체크로 끄고 켤 수 있어요." },
  { icon: "⭕", name: "올가미 선택", desc: "올가미 도구로 필기 주변을 빙 둘러 그리면 선택돼요.\n\n• 선택 영역을 끌면 통째로 이동\n• 🗑 버튼으로 한꺼번에 삭제\n• ✨ AI 메뉴에서 '선택한 필기를 텍스트로'를 누르면 그 부분만 텍스트로 변환\n\n판서 위치를 옮기거나 정리할 때 편해요." },
  { icon: "📄", name: "PDF 필기·검색", desc: "책장의 'PDF로 새 노트'로 교재·학습지 PDF를 열어 그 위에 바로 필기할 수 있어요.\n\n• 필기 화면 페이지 메뉴(⋮) → 'PDF 가져와 삽입': 지금 노트 중간에 끼워 넣기\n• 페이지 목록(1/30 버튼)의 검색창: PDF 내용으로 페이지 찾기\n• 페이지 메뉴 → 'PDF로 내보내기': 필기 포함 PDF로 저장·인쇄" },
  { icon: "🎙", name: "녹음 + 필기 재생", desc: "필기 화면 상단 🎙를 누르고 수업하며 필기하세요.\n\n🎧 목록에서 재생하면 필기가 처음엔 흐리게 보이다가 소리에 맞춰 나타나요. ✋ 손 도구로 필기를 탭하면 그 부분을 쓴 시점으로 오디오가 점프!\n\n배속(1×/1.5×/2×) 재생과 📝 AI 받아쓰기도 돼요." },
  { icon: "✍️", name: "손글씨 → 텍스트", desc: "필기 화면 상단 ✨ 메뉴에서:\n\n• '선택한 필기를 텍스트로': 올가미로 둘러 선택한 손글씨를 인식\n• '페이지 필기를 텍스트로': 페이지 전체 인식\n\n결과를 복사하거나, 텍스트 상자로 추가하거나, 손글씨와 교체할 수 있어요. 설정 없이 무료로 쓸 수 있어요." },
  { icon: "✨", name: "AI 요약·퀴즈", desc: "필기 화면 상단 ✨ 메뉴에서 페이지 내용을 AI가 도와줘요.\n\n• AI 요약·정리: 핵심 개념 정리\n• AI 퀴즈 만들기: 학생용 확인 문제 5개(정답·해설 포함)\n• AI 글 다듬기: 맞춤법·문장 교정\n\n처음 한 번만 무료 Gemini API 키를 넣으면 돼요 (안내 창이 알려줘요)." },
  { icon: "📑", name: "페이지 썸네일", desc: "필기 화면 상단의 '1 / 5' 페이지 표시를 누르면 모든 페이지의 미리보기가 격자로 떠요.\n\n원하는 페이지를 누르면 바로 이동! ＋ 버튼으로 페이지를 추가하고, ⋮ 메뉴에서 백지·줄노트·모눈 템플릿을 골라 넣을 수 있어요." },
  { icon: "📐", name: "도형 자동 보정", desc: "펜으로 선이나 도형을 그린 뒤, 펜을 떼지 말고 잠깐(0.6초) 멈춰 보세요.\n\n• 밑줄·직선 → 곧은 직선으로\n• 동그라미 → 매끈한 원으로\n• 네모 → 반듯한 사각형으로 바뀌어요\n\n바뀐 상태에서 계속 끌면 크기를 조절할 수 있어요. 그냥 그리고 바로 떼면 손글씨 그대로 남아요." },
  { icon: "📁", name: "폴더 정리", desc: "책장에서 노트북을 폴더로 정리할 수 있어요.\n\n• 노트북 목록 위 '＋ 새 폴더'로 폴더 만들기\n• 노트북의 ⋮ → '폴더로 이동'\n• 폴더 탭을 누르면 그 폴더만 보기\n• 선택된 폴더 탭을 한 번 더 누르면 이름 바꾸기·삭제\n\n폴더를 보면서 새 노트북을 만들면 자동으로 그 폴더에 들어가요." },
];

function renderFeatureStrip() {
  const strip = $("feature-strip");
  strip.innerHTML = "";
  for (const f of FEATURES) {
    const chip = document.createElement("button");
    chip.className = "feature-chip";
    chip.innerHTML = `<span class="fc-icon">${f.icon}</span><span>${f.name}</span>`;
    chip.addEventListener("click", () => {
      $("guide-title").textContent = `${f.icon} ${f.name}`;
      $("guide-desc").textContent = f.desc;
      $("modal-guide").classList.remove("hidden");
    });
    strip.appendChild(chip);
  }
}

let shelfFilter = "";

function renderShelf() {
  const grid = $("shelf-grid");
  grid.innerHTML = "";
  let list = ctx.notebooks;
  if (currentFolder) list = list.filter((nb) => nb.folder === currentFolder.id);
  if (shelfFilter) list = list.filter((nb) => (nb.title || "").toLowerCase().includes(shelfFilter));
  $("shelf-empty").classList.toggle("hidden", list.length > 0);
  $("shelf-empty").querySelector("p").innerHTML = shelfFilter
    ? "검색 결과가 없어요."
    : currentFolder
      ? "이 폴더는 비어 있어요.<br/>노트북의 ⋮ → '폴더로 이동'으로 옮겨 보세요."
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

// ---------- 이름 입력 모달 (노트북/폴더 공용) ----------
let menuTarget = null;
let promptCb = null;

function openTextPrompt(title, initial, cb) {
  $("rename-title").textContent = title;
  $("rename-input").value = initial || "";
  promptCb = cb;
  $("modal-rename").classList.remove("hidden");
  setTimeout(() => { $("rename-input").focus(); $("rename-input").select(); }, 60);
}

function submitTextPrompt() {
  const v = $("rename-input").value.trim();
  $("modal-rename").classList.add("hidden");
  const cb = promptCb;
  promptCb = null;
  if (v && cb) cb(v);
}

// ---------- 노트북 메뉴 ----------
function notebookMenu(nb) {
  menuTarget = nb;
  $("nbmenu-title").textContent = nb.title || "제목 없음";
  $("modal-nbmenu").classList.remove("hidden");
}

export function openRenameNotebook(nb, cb = null) {
  openTextPrompt("이름 바꾸기", nb.title, async (t) => {
    if (t === nb.title) return;
    try {
      const { fs, db } = ctx.fb;
      await fs.updateDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", nb.id), {
        title: t, updatedAt: fs.serverTimestamp(),
      });
      nb.title = t;
      if (cb) cb(t);
      toast("이름을 바꿨어요");
    } catch (e) {
      console.error(e);
      toast("이름 변경에 실패했어요: " + (e.message || e));
    }
  });
}

// ---------- 폴더 ----------
let currentFolder = null; // null = 전체
let unsubFolders = null;
let folderMenuTarget = null;

function folderCol() {
  const { fs, db } = ctx.fb;
  return fs.collection(db, "users", ctx.user.uid, "folders");
}

function watchFolders() {
  const { fs } = ctx.fb;
  if (unsubFolders) unsubFolders();
  const q = fs.query(folderCol(), fs.orderBy("createdAt", "asc"));
  unsubFolders = fs.onSnapshot(q, (snap) => {
    ctx.folders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (currentFolder && !ctx.folders.some((f) => f.id === currentFolder.id)) currentFolder = null;
    renderFolderTabs();
    renderShelf();
  }, (e) => console.error(e));
}

function renderFolderTabs() {
  const wrap = $("folder-tabs");
  wrap.innerHTML = "";
  const mkTab = (label, selected, onClick) => {
    const b = document.createElement("button");
    b.className = "folder-tab" + (selected ? " selected" : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    wrap.appendChild(b);
    return b;
  };
  mkTab("전체", !currentFolder, () => { currentFolder = null; renderFolderTabs(); renderShelf(); });
  for (const f of ctx.folders || []) {
    mkTab(`📁 ${f.name}`, currentFolder?.id === f.id, () => {
      if (currentFolder?.id === f.id) {
        // 선택된 폴더를 다시 누르면 폴더 메뉴
        folderMenuTarget = f;
        $("foldermenu-title").textContent = `📁 ${f.name}`;
        $("modal-foldermenu").classList.remove("hidden");
      } else {
        currentFolder = f;
        renderFolderTabs(); renderShelf();
      }
    });
  }
  mkTab("＋ 새 폴더", false, () => {
    openTextPrompt("새 폴더", "", async (name) => {
      try {
        const { fs } = ctx.fb;
        await fs.setDoc(fs.doc(folderCol()), { name, createdAt: fs.serverTimestamp() });
        toast(`"${name}" 폴더를 만들었어요`);
      } catch (e) { console.error(e); toast("폴더 만들기에 실패했어요: " + (e.message || e)); }
    });
  });
}

function openMoveModal(nb) {
  const list = $("move-list");
  list.innerHTML = "";
  const mkItem = (label, folderId) => {
    const b = document.createElement("button");
    b.className = "sheet-btn" + ((nb.folder || null) === folderId ? " current-folder" : "");
    b.textContent = label;
    b.addEventListener("click", async () => {
      $("modal-move").classList.add("hidden");
      try {
        const { fs, db } = ctx.fb;
        await fs.updateDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", nb.id), { folder: folderId });
        toast(folderId ? "폴더로 옮겼어요" : "폴더에서 꺼냈어요");
      } catch (e) { console.error(e); toast("이동에 실패했어요: " + (e.message || e)); }
    });
    list.appendChild(b);
  };
  mkItem("📂 폴더 없음", null);
  for (const f of ctx.folders || []) mkItem(`📁 ${f.name}`, f.id);
  $("move-title").textContent = `"${nb.title}" 이동`;
  $("modal-move").classList.remove("hidden");
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
    folder: currentFolder?.id || null, // 폴더를 보고 있으면 그 폴더에 생성
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
          folder: currentFolder?.id || null,
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

  // 기능 안내
  renderFeatureStrip();
  $("guide-close").addEventListener("click", () => $("modal-guide").classList.add("hidden"));
  $("modal-guide").addEventListener("click", (e) => {
    if (e.target.id === "modal-guide") $("modal-guide").classList.add("hidden");
  });

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
  $("rename-cancel").addEventListener("click", () => { promptCb = null; $("modal-rename").classList.add("hidden"); });
  $("rename-save").addEventListener("click", submitTextPrompt);
  $("rename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitTextPrompt();
    if (e.key === "Escape") { promptCb = null; $("modal-rename").classList.add("hidden"); }
  });

  // 폴더
  $("nbmenu-move").addEventListener("click", () => {
    $("modal-nbmenu").classList.add("hidden");
    if (menuTarget) openMoveModal(menuTarget);
  });
  $("move-cancel").addEventListener("click", () => $("modal-move").classList.add("hidden"));
  $("foldermenu-cancel").addEventListener("click", () => $("modal-foldermenu").classList.add("hidden"));
  $("foldermenu-rename").addEventListener("click", () => {
    $("modal-foldermenu").classList.add("hidden");
    const f = folderMenuTarget;
    if (!f) return;
    openTextPrompt("폴더 이름 바꾸기", f.name, async (name) => {
      try {
        const { fs } = ctx.fb;
        await fs.updateDoc(fs.doc(folderCol(), f.id), { name });
        toast("폴더 이름을 바꿨어요");
      } catch (e) { console.error(e); toast("이름 변경에 실패했어요: " + (e.message || e)); }
    });
  });
  $("foldermenu-delete").addEventListener("click", async () => {
    $("modal-foldermenu").classList.add("hidden");
    const f = folderMenuTarget;
    if (!f) return;
    if (!confirm(`"${f.name}" 폴더를 삭제할까요?\n폴더 안의 노트북은 삭제되지 않고 '전체'로 이동해요.`)) return;
    try {
      const { fs, db } = ctx.fb;
      for (const nb of ctx.notebooks.filter((n) => n.folder === f.id)) {
        await fs.updateDoc(fs.doc(db, "users", ctx.user.uid, "notebooks", nb.id), { folder: null });
      }
      await fs.deleteDoc(fs.doc(folderCol(), f.id));
      if (currentFolder?.id === f.id) currentFolder = null;
      toast("폴더를 삭제했어요");
    } catch (e) { console.error(e); toast("폴더 삭제에 실패했어요: " + (e.message || e)); }
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
