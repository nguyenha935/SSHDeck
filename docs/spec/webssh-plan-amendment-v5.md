# Phụ lục sửa lỗi toolbar, session strip, composer và tên sản phẩm v5

Ngày cập nhật: 2026-08-04  
Phạm vi: phụ lục này thay thế các quyết định xung đột ở mục 1, 3, 4, 6 và 7 của `webssh-plan-amendment-v4.md`. Những phần không xung đột vẫn theo plan v2, phụ lục v3 và v4. Đây mới là đặc tả để Cậu kiểm duyệt; chưa cho phép sửa source, giao Claude triển khai, deploy, commit, push hoặc PR.

## 1. Lỗi của hướng v4 và quyết định thay thế

- Không được chỉ giảm chiều cao session row rồi để chip dính sát hai đường viền.
- Không được lấy action ra khỏi iPad/mobile để đổi lấy chiều ngang cho session strip.
- Không được tạo một composer Broadcast riêng trên desktop hay một nhánh composer riêng theo thiết bị.
- Không được thêm chữ `Broadcast` vào toolbar hẹp; label đó làm giảm trực tiếp vùng dành cho session.
- Không được để iPad/mobile thiếu Broadcast, Lưu transcript, Kết nối lại, Ghi chú hoặc Bố cục.
- Tên `TermWeave` bị loại vì khó đọc, khó nhớ và không nói thẳng sản phẩm dùng SSH.

## 2. Working name mới

Working name đề xuất là **SSHDeck**.

- `SSH` nói thẳng phạm vi cốt lõi của sản phẩm.
- `Deck` mô tả một nơi tập hợp, chuyển và sắp xếp nhiều phiên/pane; phù hợp multi-session, split layout và broadcast.
- Tên gồm 7 ký tự ASCII, dễ đọc, dễ nhớ và không cần giải thích thuật ngữ TTY.
- Logo chính tiếp tục là biểu tượng terminal vuông hiện tại.

Hai tên chỉ để so sánh trong mockup là `SSHHub` và `SSHPane`; không dùng làm đề xuất chính. `SSHDeck` chỉ được chốt làm tên public sau gate kiểm tra repository, package, domain và nhãn hiệu. Không tự đổi package, namespace, endpoint hoặc tên service trong phase giao diện.

## 3. Cấu trúc header và session trên touch

Touch header có hai hàng với trách nhiệm tách biệt:

1. Global/action row cao 44px.
2. Session row cao 44px và chỉ chứa session strip.

Global/action row phải giữ đủ sáu action trên iPad và mobile:

1. Bố cục.
2. Broadcast.
3. Lưu transcript.
4. Kết nối lại.
5. Ghi chú.
6. Menu toàn cục.

Quy tắc:

- Sáu action dùng icon-only, mỗi nút có accessible name và tooltip; không có chữ `Broadcast` chiếm chiều ngang.
- Không tạo nút menu thứ hai ở session row hoặc composer.
- Ở phone 359px, chữ `SSHDeck` được ẩn, giữ logo; cả sáu action vẫn hiện và không cuộn, không wrap.
- Cụm sáu action trong mockup rộng 267px ở phone 359px; global row không overflow.
- iPad ngang và phone ngang vẫn giữ đúng sáu action, không tự bỏ Lưu transcript/Kết nối lại/Broadcast.

Session row:

- Không chứa action, spacer hay menu; session strip dùng toàn bộ chiều ngang còn lại sau padding hai bên.
- Chip nhìn thấy cao 30px, căn giữa trong row 44px.
- Phép đo mockup: khoảng hở trên 7.3px, dưới 6.7px; phone landscape dùng row 40px với khoảng hở khoảng 5.3px/4.7px.
- Vùng bấm phải được mở rộng theo chiều dọc tới 44px mà không làm nền/border chip chạm viền và không lấn vùng bấm ngang của chip bên cạnh.
- Session disconnected/candidate vẫn bấm được để chọn; chạm lại hoặc nhấn giữ mới mở action sheet. Không tự focus composer và không tự bật bàn phím khi chỉ chọn session.
- Session strip chỉ pan ngang; khóa pan dọc cho chính strip, không chặn cuộn dọc của trang bên ngoài.

## 4. Toolbar desktop

- Global header giữ navigation cấp ứng dụng; session/workspace row giữ session strip và contextual toolbar.
- Contextual toolbar dùng icon-only cho Bố cục, Broadcast, Lưu transcript, Kết nối lại và Ghi chú; tổng chiều rộng mục tiêu khoảng 180px.
- Session strip nhận toàn bộ phần còn lại; không thêm text `Broadcast` vào cụm contextual action.
- Desktop bình thường không hiển thị composer.
- Mọi nút, menu item và label dùng một dòng; không được tăng chiều cao vì wrap.

## 5. Một composer duy nhất dùng chung

Ứng dụng chỉ được có **một composer component/DOM instance và một luồng state** cho nhập lệnh. Không tạo `DesktopBroadcastComposer`, không clone composer cho touch, không mount hai composer rồi ẩn một cái bằng CSS.

Ma trận hiển thị:

| Thiết bị / trạng thái | Composer | Target | Nút gửi |
|---|---|---|---|
| Desktop thường | Ẩn | Không có | Không có |
| Desktop Broadcast | Hiện chính composer chung | `Tất cả N` | Icon + `Gửi tất cả` |
| iPad/mobile thường | Hiện chính composer chung | Phiên đang chọn, không cần badge Broadcast | Icon gửi |
| iPad/mobile Broadcast | Vẫn chính composer đó | `Tất cả N` | Icon gửi |

Quy tắc hành vi:

- Broadcast là công tắc đổi target của composer chung; không tạo composer hoặc draft thứ hai.
- `N` chỉ tính session đang kết nối và gửi được; session disconnected/candidate bị loại khỏi target.
- Bật/tắt Broadcast không tự focus composer trên touch và không tự mở bàn phím.
- Gõ thường tiếp tục streaming theo hợp đồng cũ ở touch. Paste/drop và IME composition không được gửi tức thì; nội dung ở lại composer để sửa rồi mới bấm Gửi.
- Chuyển target không tự gửi và không xóa draft. Target hiện hành phải luôn nhìn thấy rõ trước khi gửi Broadcast.
- Composer tự giãn theo nội dung đến cap; helper luôn một dòng và không ép nút xuống dòng.

## 6. Bố cục, dropdown và keypad

- Giữ cap: desktop 1–6 pane; iPad 1–4; phone portrait/landscape 1–2.
- Layout dropdown nằm ngay dưới nút Bố cục ở global/action row trên touch và contextual row trên desktop.
- Global menu nằm ngay dưới nút Menu/Tài khoản; cạnh phải không vượt product viewport.
- Keypad nằm sau composer theo flex flow như bàn phím; mở keypad phải co terminal, không overlay terminal.
- Bản mockup đo được workspace còn dương khi mở keypad: iPad khoảng 445px, phone 359 khoảng 508px, phone landscape khoảng 162px.

## 7. Gate nghiệm thu trước khi cho Claude sửa source

- [ ] iPad dọc/ngang và phone portrait/landscape đều có đủ sáu action; không action nào bị ẩn hoặc wrap.
- [ ] Session strip dùng trọn hàng riêng; chip có khoảng hở đo được với cả hai đường viền.
- [ ] Session disconnected/candidate bấm được nhưng không tự mở bàn phím.
- [ ] Toàn ứng dụng chỉ có một composer instance.
- [ ] Desktop Broadcast off: composer ẩn; on: đúng composer chung hiện với `Tất cả N` và `Gửi tất cả`.
- [ ] Touch Broadcast off/on dùng cùng composer; on chỉ thêm/chuyển target sang `Tất cả N`.
- [ ] Paste/drop/IME không tự gửi; gõ thường vẫn giữ streaming hiện có.
- [ ] Desktop toolbar khoảng 180px; touch action cluster khoảng 267px; không thêm label Broadcast vào toolbar.
- [ ] Dropdown bám trigger, không clip; layout option lọc đúng cap thiết bị.
- [ ] Keypad ở sau composer, terminal còn chiều cao dương và không bị che.
- [ ] Mọi theme hiện có vẫn hoạt động; implementation không hardcode lại theme hoặc đổi token ngoài phạm vi.
- [ ] Chỉ sau khi Cậu duyệt mockup và phụ lục v5 mới được chuyển thành prompt implementation cho Claude.

## 8. Kết quả kiểm tra mockup v5

- iPad, phone 390, phone 359 và phone landscape: đủ đúng sáu action, không wrap, không overflow.
- Session chip: 30px trong row 44px; khoảng hở trên/dưới đạt khoảng 7.3px/6.7px.
- Mỗi trạng thái chỉ có một composer element. Desktop thường ẩn; Desktop Broadcast hiện; touch luôn dùng cùng element.
- Broadcast trên iPad/mobile hiển thị target `Tất cả 3`; không có composer riêng.
- Layout menu: desktop có 1–6, iPad 1–4, phone 1–2; menu nằm trong viewport.
- Keypad không overlap workspace/composer ở các viewport đã kiểm tra.
- Không phát hiện console error/warning trong lần kiểm tra cuối.