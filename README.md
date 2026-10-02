# Fieldbook — website quản lý công trình chạy độc lập trên Ugreen NAS

Fieldbook là một website hoàn chỉnh (front end + back end) chạy **trên NAS hoặc máy tính của bạn**.
Không cần tài khoản Claude, không cần dịch vụ đám mây nào: dữ liệu, ảnh, hoá đơn, tài khoản người dùng đều nằm trên NAS.

**Tính năng** (đầy đủ như bản Fieldbook v23): Trang chủ với thống kê và cảnh báo · Dự án, ngân sách, dòng tiền · Tiến độ (timeline, mốc, giao việc) · Hoá đơn (tải ảnh/PDF, AI đọc, duyệt, ghi sổ chi phí, quy tắc tự duyệt, xuất GL/QuickBooks) · Kho hàng · Ảnh công trình (gắn thẻ, vẽ chú thích, so sánh trước/sau, báo cáo ảnh) · Trao đổi · Khách hàng · Checklist & mẫu · Tài liệu (PDF, Word, Excel) · Bản đồ · Lịch · Nhân sự · Thời tiết 3 ngày cho từng công trình · E-mail buổi sáng · Người dùng & phân quyền (Quản trị, Quản lý dự án, Kế toán) và nhật ký thao tác · Giao diện tiếng Anh / tiếng Việt, sáng / tối, dùng tốt trên điện thoại.

| Phần | Chạy ở đâu | Cần Internet? |
|---|---|---|
| Website, đăng nhập, dữ liệu, ảnh, tài liệu, phân quyền, đồng bộ giữa các máy | Trên NAS | Không |
| Sao lưu hằng ngày | Trên NAS | Không |
| E-mail buổi sáng | NAS gửi qua máy chủ mail của bạn | Cần mạng tới máy chủ mail |
| Thời tiết công trình | NAS lấy từ Open-Meteo (miễn phí) | Có |
| AI đọc hoá đơn (tuỳ chọn) | **Máy AI trong văn phòng** (Ollama/LM Studio) hoặc dịch vụ đám mây | Không, nếu dùng AI nội bộ |
| Bản đồ nhúng | Google Maps | Có (không có thì hiện nút mở bản đồ) |

---

## 0. Hai cách chạy — dữ liệu luôn ở trên NAS

```
                         ┌──────────────── GitHub ────────────────┐
   git push ───────────► │ Actions: kiểm tra → build website + image│
                         └───────┬─────────────────────┬───────────┘
                                 │ GitHub Pages        │ ghcr.io image
                                 ▼                     ▼ (NAS tự cập nhật)
  Trình duyệt ở bất cứ đâu ──► website ──HTTPS──► Cloudflare Tunnel ──► NAS: Fieldbook server
  Trình duyệt trong văn phòng ─────────── http://IP-NAS:8080 ─────────► + cơ sở dữ liệu thời gian thực
                                                                         + ảnh, hoá đơn, sao lưu
```

- **Cách A – tất cả trên NAS** (mục 1–2): NAS phục vụ cả website lẫn dữ liệu. Không cần GitHub.
- **Cách B – mã nguồn trên GitHub** (mục 10): mỗi lần `git push`, GitHub kiểm tra mã, đưa website lên **GitHub Pages** và build **image Docker** cho NAS. NAS tự cập nhật bản mới. Cơ sở dữ liệu thời gian thực, ảnh, hoá đơn và tài khoản **vẫn chỉ nằm trên NAS**. GitHub chỉ giữ mã nguồn, không giữ dữ liệu.

Hai cách dùng chung một mã nguồn và có thể chạy song song: trong văn phòng vào `http://IP-NAS:8080`, ở ngoài vào địa chỉ GitHub Pages. Mọi người cùng thấy một dữ liệu, cập nhật tức thì.

## 1. Cài trên Ugreen NAS (UGOS Pro) — không cần lệnh

1. **App Center → cài Docker.**
2. Giải nén gói này, chép **cả thư mục `fieldbook`** lên NAS, ví dụ vào `docker/fieldbook` (dùng File Manager).
3. Trong thư mục đó, **đổi tên `.env.example` thành `.env`** (có thể mở ra sửa sau, xem mục 4).
4. Mở **Docker → Project (Dự án) → Create (Tạo)**:
   - Tên: `fieldbook`
   - Đường dẫn: chọn thư mục `docker/fieldbook`
   - Nguồn: dùng file `docker-compose.yml` có sẵn trong thư mục → **Deploy / Triển khai**.

   Docker chỉ tải ảnh `node:22-alpine` chính thức (khoảng 50 MB), không cần build.
5. Trên máy tính trong văn phòng mở **`http://<IP-của-NAS>:8080`** → màn hình **Set up Fieldbook** → tạo tài khoản chủ sở hữu (luôn là Quản trị viên).

Fieldbook tạo sẵn vài dự án mẫu để bạn xem thử; xoá trong **Cài đặt → Xoá dữ liệu** khi bắt đầu dùng thật.

Muốn dùng lệnh (SSH) thì tương đương: `cd /volume1/docker/fieldbook && docker compose up -d`.

## 2. Chạy trên máy tính (localhost)

Cài **Node.js 22** (https://nodejs.org, bản LTS 22.13 trở lên), rồi:

- Windows: bấm đúp **`start.bat`**
- macOS / Linux: `./start.sh`

Mở **http://localhost:8080**. Dữ liệu nằm trong thư mục `data/` bên cạnh.
Máy khác trong mạng vào bằng `http://<IP-máy-này>:8080`.

## 3. Truy cập từ ngoài văn phòng (tuỳ chọn, Cloudflare Tunnel)

Không cần mở cổng modem.

1. **Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared), chép **token**.
2. *Public Hostname*: ví dụ `fieldbook.congty.com`, **Service** = `HTTP` → `fieldbook:8080`.
3. Trong `.env`: `PUBLIC_URL=https://fieldbook.congty.com`, `TRUST_PROXY=true`, `CLOUDFLARE_TUNNEL_TOKEN=<token>`.
4. Chạy kèm tunnel: `docker compose --profile tunnel up -d` (hoặc trong UGOS thêm profile `tunnel` cho dự án).

Trong văn phòng vẫn dùng `http://<IP-NAS>:8080` bình thường.

## 4. Cấu hình (`.env`)

| Biến | Ý nghĩa |
|---|---|
| `ALLOW_SIGNUP` | `true`: người mới tự tạo tài khoản rồi chờ Admin duyệt. `false`: chỉ Admin tạo tài khoản. |
| `PUBLIC_URL`, `TRUST_PROXY` | Dùng khi truy cập từ ngoài qua Cloudflare (mục 3). |
| `ALLOWED_ORIGINS` | Địa chỉ website trên GitHub Pages được phép dùng máy chủ này (mục 10). |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL` | AI nội bộ (Ollama / LM Studio), xem mục 5. |
| `ANTHROPIC_API_KEY` | Hoặc AI đám mây của Anthropic. Bỏ trống tất cả = tắt AI. |
| `SMTP_URL`, `MAIL_FROM`, `MAIL_LANG` | Máy chủ mail để gửi e-mail buổi sáng và e-mail mời. Gmail: `smtps://ten%40gmail.com:MAT-KHAU-UNG-DUNG@smtp.gmail.com:465`. |
| `WEATHER` | Thời tiết công trình. `false` để tắt. |
| `BACKUP_HOUR`, `BACKUP_KEEP`, `TZ` | Giờ sao lưu hằng ngày, số bản giữ lại, múi giờ. |
| `MAX_UPLOAD_MB` | Dung lượng tối đa mỗi file (mặc định 50 MB). |

Sửa `.env` xong: khởi động lại dự án trong Docker (hoặc `docker compose up -d`).

## 5. AI chạy ngay trong văn phòng (không gửi dữ liệu ra ngoài)

Fieldbook nói chuyện được với mọi máy chủ AI kiểu OpenAI. Cách đơn giản nhất:

1. Trên một máy tính có card đồ hoạ (hoặc chính NAS nếu đủ mạnh), cài **Ollama** (https://ollama.com).
2. Tải model đọc được ảnh: `ollama pull qwen2.5vl:7b`
3. Cho phép máy khác gọi tới: đặt biến môi trường `OLLAMA_HOST=0.0.0.0` rồi khởi động lại Ollama.
4. Trong `.env` của Fieldbook:

   ```
   AI_PROVIDER=openai
   AI_BASE_URL=http://<IP-máy-Ollama>:11434/v1
   AI_MODEL=qwen2.5vl:7b
   ```

Model nhỏ đọc hoá đơn kém hơn dịch vụ đám mây; Fieldbook luôn để hoá đơn ở trạng thái "cần duyệt" khi không chắc chắn. Dùng đám mây thì chỉ cần `ANTHROPIC_API_KEY=...`.

## 6. Người dùng và phân quyền

- **Tự đăng ký:** trang đăng nhập → *Create an account* → chọn vai trò cần → Admin vào **Người dùng & quyền** bấm **Duyệt**. Trang của người đó tự mở khi được duyệt.
- **Admin tạo sẵn:** bấm tên mình (góc dưới trái) → **Mật khẩu & đăng xuất** → **Tài khoản đăng nhập → Thêm người**. Máy chủ tạo mật khẩu tạm (hiện một lần, hoặc gửi e-mail nếu có SMTP).
- **Quên mật khẩu:** Admin bấm **Đặt lại mật khẩu**. Nếu chính Admin duy nhất quên:
  `docker compose exec fieldbook node scripts/reset-password.js admin@congty.com`

Vai trò được kiểm tra trên máy chủ ở mọi thao tác ghi: Kế toán chỉ sửa được hoá đơn, chi phí, ngân sách; người chưa được duyệt không thấy dữ liệu nào.

## 7. Sao lưu và khôi phục

- NAS tự chụp cơ sở dữ liệu mỗi ngày vào `data/backups/` (giữ 14 bản).
- Sao lưu ngay: `docker compose exec fieldbook node scripts/backup.js`
- **Hãy sao lưu cả thư mục `data/`** (cơ sở dữ liệu + ảnh/tài liệu trong `data/uploads`) bằng tính năng Sao lưu / Snapshot của UGOS hoặc ra ổ khác.

Khôi phục: dừng dự án → chép `data/backups/fieldbook-YYYYMMDD-HHMMSS.db` thành `data/fieldbook.db` (xoá `fieldbook.db-wal`, `fieldbook.db-shm` nếu có) → chạy lại.

## 8. Cài hoàn toàn không có Internet

Mọi thứ chạy được offline, trừ thời tiết, bản đồ và AI đám mây. Riêng **trình đọc PDF** (dùng khi AI đọc hoá đơn PDF) được NAS tự tải một lần lúc cần. Nếu NAS không có Internet, tải trước hai file sau trên máy khác và chép vào `web/vendor/pdfjs/`:

- https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
- https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js

## 9. Cấu trúc mã nguồn

```
server/            back end — Node.js 22, không cần cài package nào
  index.js         khởi động; chạy e-mail buổi sáng, thời tiết, sao lưu
  app.js           HTTP: trang, đăng nhập, API dữ liệu, file, AI, cập nhật trực tiếp (SSE)
  store.js         SQLite (dữ liệu, tài khoản, phiên, file)
  auth.js          mật khẩu scrypt, phiên đăng nhập
  rules.js         phân quyền theo vai trò
  ai.js            AI nội bộ (OpenAI-compatible) hoặc Anthropic
  notify.js, mailer.js   e-mail buổi sáng (SMTP)
  weather.js       dự báo thời tiết Open-Meteo
  backup.js, vendor.js   sao lưu; trình đọc PDF
web/               front end
  index.html       ứng dụng Fieldbook
  static/fieldbook.js, fieldbook.css   giao diện và logic ứng dụng
  static/runtime.js                     kết nối giao diện với máy chủ (dữ liệu, file, AI, đăng nhập)
  static/config.js, static/client.js    địa chỉ máy chủ ("" = cùng NAS), cách đăng nhập (cookie hoặc mã)
  login.html, account.html              đăng nhập, tài khoản & quản lý người dùng
scripts/           reset-password.js, backup.js, build-pages.mjs (website cho GitHub Pages), fetch-pdfjs.sh
.github/workflows/ ci.yml (kiểm tra), pages.yml (GitHub Pages), docker.yml (image cho NAS)
docker-compose.github.yml   cài trên NAS từ image GitHub + tự cập nhật
test/              npm test — 26 bài kiểm tra
docker-compose.yml, Dockerfile, start.sh, start.bat, .env.example
```

API chính (cho ai muốn tích hợp): `GET/POST /api/db/<collection>`, `GET/PUT/DELETE /api/db/<collection>/<id>`, `POST /api/assets`, `GET /api/stream` (sự kiện thay đổi), `POST /api/sample` (AI). Mọi lệnh ghi cần header `x-fieldbook: 1` và cookie đăng nhập.

## 10. Triển khai từ GitHub (website trên GitHub Pages, dữ liệu trên NAS)

**Bước 1 – Đưa mã lên GitHub.** Tạo một repository mới (ví dụ `fieldbook`), rồi trong thư mục này:

```bash
git remote add origin https://github.com/<tên-bạn>/fieldbook.git
git push -u origin main
```

GitHub Pages miễn phí cần repository **public**. Repository private cần gói GitHub Pro/Team. Mã nguồn không chứa dữ liệu hay mật khẩu nào, vì `.env` và `data/` đã nằm trong `.gitignore`.

**Bước 2 – Cho NAS một địa chỉ HTTPS** (bắt buộc, vì trang trên GitHub Pages là https). Làm như mục 3 (Cloudflare Tunnel), ví dụ `https://fieldbook-api.congty.com` → `fieldbook:8080`. Trong `.env` trên NAS:

```
TRUST_PROXY=true
PUBLIC_URL=https://<tên-bạn>.github.io/fieldbook
ALLOWED_ORIGINS=https://<tên-bạn>.github.io
```

`ALLOWED_ORIGINS` chỉ ghi phần gốc (`https://<tên-bạn>.github.io`), không ghi `/fieldbook`. Nếu dùng tên miền riêng cho Pages thì ghi tên miền đó.

**Bước 3 – Bật GitHub Pages.** Vào repository → **Settings → Pages → Source: GitHub Actions**. Sau đó vào **Settings → Secrets and variables → Actions → Variables → New variable**: `FIELDBOOK_API_URL` = `https://fieldbook-api.congty.com`. Push lần nữa, hoặc vào **Actions → Deploy website to GitHub Pages → Run workflow**. Website sẽ có ở `https://<tên-bạn>.github.io/fieldbook/`.

**Bước 4 – NAS tự cập nhật từ GitHub (tuỳ chọn).** Workflow *Build NAS image* tạo image `ghcr.io/<tên-bạn>/fieldbook:latest` (chạy được trên cả máy Intel/AMD và ARM, có sẵn trình đọc PDF nên chạy offline được). Trên NAS:

1. Mở `docker-compose.github.yml`, sửa `ghcr.io/OWNER/REPO` thành `ghcr.io/<tên-bạn>/fieldbook` (chữ thường).
2. Dừng dự án cũ (nếu đang chạy theo mục 1), rồi tạo dự án mới từ `docker-compose.github.yml`, hoặc chạy `docker compose -f docker-compose.github.yml up -d`. Thư mục `data/` giữ nguyên, nên dữ liệu không mất.
3. Image mặc định là private. Hãy đặt nó **public** (GitHub → Packages → fieldbook → Package settings → Change visibility). Nếu muốn giữ private, chạy `docker login ghcr.io` trên NAS bằng một token có quyền `read:packages`, rồi bỏ dấu `#` ở dòng `config.json` trong file compose.

Dịch vụ `watchtower` trong file đó kiểm tra mỗi 5 phút và tự khởi động lại Fieldbook với bản mới. Bản gốc `containrrr/watchtower` đã ngừng phát triển từ tháng 12/2025, nên file dùng bản kế thừa `nickfedor/watchtower`.

**Đăng nhập khi dùng GitHub Pages:** trình duyệt không gửi cookie sang trang khác, nên trang GitHub Pages dùng **mã đăng nhập** lưu trong trình duyệt. Ảnh và PDF được mở qua đường link có khoá riêng của từng người, hết hạn sau 12 giờ và tự làm mới. Bấm **Mật khẩu & đăng xuất → Đăng xuất** để xoá mã khỏi máy đang dùng.

**Mỗi workflow làm gì** (thư mục `.github/workflows/`):

| Workflow | Khi nào chạy | Làm gì |
|---|---|---|
| `ci.yml` | Mọi lần push và pull request | Chạy 26 bài kiểm tra |
| `pages.yml` | Push lên `main` có thay đổi trong `web/` | Kiểm tra → build website với địa chỉ NAS → đưa lên GitHub Pages |
| `docker.yml` | Push lên `main`, hoặc tag `v*` | Kiểm tra → build image cho NAS → đẩy lên `ghcr.io` |

Thử build website trên máy: `node scripts/build-pages.mjs --api https://fieldbook-api.congty.com --out _site`

## 11. Bảo mật

Mật khẩu băm scrypt; cookie phiên HttpOnly + SameSite, máy chủ chỉ lưu hash của phiên; giới hạn số lần đăng nhập sai; chặn gửi form chéo trang; phân quyền ở máy chủ; file tải lên không bao giờ chạy như trang web; Content-Security-Policy không cho chạy script lạ; API key AI chỉ nằm trên NAS; nhật ký thao tác của mỗi người chỉ được thêm, không xoá được.

## 12. Sự cố thường gặp

- **Không vào được trang:** xem log dự án trong Docker (hoặc `docker compose logs -f fieldbook`).
- **Báo lỗi `.env` không tồn tại:** đổi tên `.env.example` thành `.env`.
- **Đăng nhập xong lại quay về trang đăng nhập:** bỏ dòng `COOKIE_SECURE=true` nếu bạn vào bằng `http://`.
- **Không có thời tiết:** địa chỉ dự án cần có thành phố (vd. `12 Lê Lợi, Quận 1, TP. Hồ Chí Minh`) và NAS cần Internet.
- **Trang GitHub Pages báo "Can't reach the Fieldbook server":** kiểm tra `FIELDBOOK_API_URL` (biến của GitHub) có trùng địa chỉ Cloudflare của NAS không, và `ALLOWED_ORIGINS` trong `.env` trên NAS có địa chỉ trang Pages không (vd. `https://ten-ban.github.io`). Sửa `.env` xong thì khởi động lại Fieldbook.
- **Mở nhiều tab qua `http://IP:8080` thì chậm/treo:** trình duyệt chỉ mở 6 kết nối tới một địa chỉ http; dùng ít tab hơn hoặc dùng địa chỉ https.
- **E-mail buổi sáng không đi:** kiểm tra `SMTP_URL`, xem log `[mail]`; danh sách đã gửi có trong **Cài đặt → E-mail buổi sáng**.
