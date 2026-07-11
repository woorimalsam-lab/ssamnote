// ============================================================
//  우리말쌤노트 설정
//  - Firebase 설정은 '우리말샘 핀' / '학급 게시판'과 같은 프로젝트를 사용합니다.
//  - 이 값들은 웹에 공개돼도 되는 값입니다(비밀번호 아님).
//    보안은 Firestore 규칙(users/{uid} 본인만 읽기·쓰기)으로 처리합니다.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDxCefa6kRAGkq5zWFKiX-Ikiy0eXqI-cs",
  authDomain: "woorimalsam-7f454.firebaseapp.com",
  projectId: "woorimalsam-7f454",
  storageBucket: "woorimalsam-7f454.firebasestorage.app",
  messagingSenderId: "488196268358",
  appId: "1:488196268358:web:fc8446a9c8c09c62e8c547",
  measurementId: "G-RN0PNKFEBC",
};

// 앱 이름 (상단에 표시)
export const APP_NAME = "우리말쌤노트";
