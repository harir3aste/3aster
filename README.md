# VLESS over WebSocket

سرور VLESS روی WebSocket (فقط TCP) با یک صفحهٔ کوچک که لینک اتصال را نشان می‌دهد.
فقط یک وابستگی دارد: `ws`.

## فایل‌ها
- `index.js` — کل برنامه
- `package.json` — وابستگی‌ها و دستور start
- `Dockerfile` — اختیاری، برای پلتفرم‌هایی که Docker می‌خواهند (اگر لازم نداری پاکش کن)

## اجرا
```
npm install
VLESS_UUID=<uuid-خودت> node index.js
```
UUID جدید: `node -e "console.log(require('crypto').randomUUID())"`

## متغیرهای محیطی
| نام | توضیح |
|---|---|
| `VLESS_UUID` | شناسهٔ کاربر. **حتماً روی هاست‌های بدون دیسک ثابت تنظیم شود** |
| `VLESS_NAME` | اسم لینک و آخر path (پیش‌فرض `Luffy`) |
| `VLESS_HOST` / `VLESS_PORT` | آدرس و پورت عمومی لینک (پیش‌فرض: از درخواست خوانده می‌شود) |
| `VLESS_TLS` | مقدار `1` یعنی لینک همیشه `security=tls` باشد |
| `VLESS_DEBUG` | مقدار `1` یعنی مقصدها هم در لاگ چاپ شوند |
| `PORT` / `SERVER_PORT` | پورت گوش‌دادن (پیش‌فرض 8000) |

## استفاده
بعد از اجرا، آدرس سرویس را در مرورگر باز کن و لینک را کپی کن.
مسیر WebSocket: `/ws/<VLESS_NAME>` — سلامت سرویس: `/health`

در کلاینت: transport = ws، path = `/ws/Luffy`، و اگر آدرس HTTPS است TLS روشن (alpn = http/1.1).

## امنیت
- ریپو را **Private** نگه دار و UUID را فقط در متغیر محیطی بگذار، نه داخل فایل‌ها.
- از قوانین هاست خودت برای اجرای پروکسی مطمئن شو.
