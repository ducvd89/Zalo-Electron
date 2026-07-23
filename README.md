# Zalo Web Desktop

Ứng dụng Zalo cho máy tính (bọc bản web `chat.zalo.me`) — Windows / macOS / Linux, xây dựng bằng Electron.

## Chạy thử

```bash
npm install
npm start
```

## Đóng gói

| Lệnh | Kết quả |
|---|---|
| `npm run dist:win` | File cài đặt `.exe` (NSIS) cho Windows |
| `npm run dist:linux` | Gói `.pacman` cho Arch/CachyOS (chạy trên máy Linux) |
| `npm run dist:mac` | File `.dmg` cho macOS (chạy trên máy Mac) |

File xuất ra nằm trong thư mục `dist/`.

> Lưu ý: gói `.pacman` phải build trên Linux, `.dmg` phải build trên macOS
> (giới hạn của electron-builder). Build `.exe` thực hiện ngay trên Windows.

## Tính năng

- Khay hệ thống: Mở ứng dụng / Tải lại trang / Khởi động cùng hệ thống (có
  dấu tick trạng thái) / Thoát hẳn; bấm (X) chỉ ẩn app xuống khay.
- Đếm tin nhắn chưa đọc từ tiêu đề trang: tooltip ở khay, chấm đỏ trên
  Taskbar (Windows) và badge trên Dock (macOS) / Launcher (Linux).
- Chuột phải: sao chép chữ, sao chép/lưu hình ảnh, sao chép/mở liên kết.
- Link ngoài mở bằng trình duyệt mặc định; deep-link `zalo://` bị chặn để
  không bị đá văng sang app Zalo gốc của hệ điều hành.
- Cho phép popup `about:blank` và link nội bộ zalo.me / zaloapp.com để gọi
  thoại / gọi video (WebRTC) hoạt động.
- Mất mạng: tự thử lại tối đa 10 lần, hỏng hẳn thì hiện trang lỗi thân thiện,
  có mạng lại thì tự kết nối.
- macOS: có Application Menu để Cmd+C / Cmd+V / Cmd+Q hoạt động.
- User-Agent Chrome mới cài toàn cục để Zalo không chặn "trình duyệt cũ".
