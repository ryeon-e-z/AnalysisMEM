# 다같이 뽑기 — 아이폰 업로드용

아이폰에서 GitHub에 올리기 쉽게 모든 필수 파일을 한 폴더 안에 평평하게 넣었습니다.

## GitHub에 올릴 파일
압축을 푼 뒤 `group-draw-site-iphone` 폴더 안에서 아래 파일을 **전부 선택해서 한 번에 업로드**하세요.

- `index.html`
- `server.js`
- `package.json`
- `render.yaml`
- `README.md`

GitHub 저장소 첫 화면에 위 파일들이 바로 보이면 정상입니다.

## 아이폰 배포 순서
1. Safari → github.com 로그인
2. `+` → `New repository`
3. 이름 `group-draw` → `Public` → `Create repository`
4. `uploading an existing file` 또는 `Add file` → `Upload files`
5. 파일 앱에서 위 5개 파일 모두 선택 → 업로드
6. `Commit changes`
7. Safari → dashboard.render.com 로그인
8. GitHub 연결
9. `+ New` → `Blueprint`
10. `group-draw` 저장소 → `Connect`
11. Blueprint path가 `render.yaml`인지 확인
12. `Deploy Blueprint` / `Apply`
13. 배포가 끝나면 `https://...onrender.com` 주소가 생김
14. 그 주소에 접속 → 방 생성 → 초대 링크를 60명에게 공유

## Render 설정
`render.yaml`에 아래가 이미 설정되어 있습니다.
- Node.js
- Free 요금제
- Singapore 리전
- Build command: `npm install`
- Start command: `npm start`

## 주의
무료 Render 서비스는 오래 사용하지 않으면 잠들 수 있으니 행사 5분 전 진행자가 사이트를 한 번 열어두세요.
방 상태는 서버 메모리에 저장되므로 서버 재시작 시 방이 초기화될 수 있습니다.
