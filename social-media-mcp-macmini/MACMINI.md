# ย้าย Social Media MCP ไป Mac mini

## ระบบทำงานอย่างไร

```text
AI client ในเครื่องอื่น
  | Streamable HTTP + Authorization: Bearer <MCP_SERVER_TOKEN>
  v
Mac mini: src/server.js → /mcp
  ├─ meta__*   → Meta MCP ผ่าน HTTPS + Employee user token
  ├─ google__* → Google MCP เป็น Python child process → Google Ads API
  └─ tiktok__* → TikTok MCP ผ่าน HTTPS + OAuth
```

AI client ตีความคำถาม เลือก tools และรวมคำตอบ Server นี้ส่งต่อ tool calls ไม่มีโมเดล AI อยู่ใน server และไม่ใช้ OpenAI API key

Server ค้น tools ตอนเริ่มและเติม prefix เพื่อไม่ให้ชื่อชนกัน เช่น `meta__ads_get_ad_accounts`, `google__customers_list_accessible_customers`, `tiktok__auth_advertiser_get` ส่วน arguments และผลลัพธ์คงรูปแบบจากแพลตฟอร์มเดิม และตรวจ input ตาม schema ก่อนส่งต่อ

เป็น server เดียวสำหรับทีมที่ไว้ใจได้ ทุก client ใช้สิทธิ์ของ platform credentials ชุดเดียวกัน รวมถึง write tools หาก token อนุญาต ไม่ได้มีการแบ่งสิทธิ์ตามสมาชิก ไม่มีการ retry tool call ที่ผิดพลาดโดยอัตโนมัติ จึงไม่เสี่ยงส่งคำสั่งแก้ไขซ้ำจากการ retry ของ gateway

## 1. ย้ายไฟล์

บนเครื่องต้นทาง สร้างชุดโค้ด:

```sh
npm run pack:mac
```

ไฟล์อยู่ที่ `dist/social-media-mcp-macmini.tar.gz` ไม่มี `.env`, `.credentials`, ผลรายงาน, logs, `node_modules` หรือ Python virtualenv

คัดลอก archive ไป Mac mini แล้วแตกในโฟลเดอร์ปลายทาง เช่น `~/SocialMediaMCP`

คัดลอก `.env` และไฟล์ภายใน `.credentials/` ผ่านช่องทางส่วนตัวแยกต่างหาก เช่น `scp` ผ่าน SSH หรือ AirDrop ลงตำแหน่งเดียวกับที่อยู่ในโปรเจกต์เดิม ห้ามส่งไฟล์ credential ผ่านแชตหรือใส่ใน source archive ที่แชร์ทั่วไป

- **Meta:** ค่า `META_ACCESS_TOKEN` ใน `.env` ต้องเป็น token ที่ใช้กับ MCP ได้และยังมีสิทธิ์ในบัญชีที่ต้องการ
- **Google:** คัดลอกไฟล์ service-account JSON ที่ `GOOGLE_APPLICATION_CREDENTIALS` ชี้ไปด้วย ใช้ path สัมพัทธ์ เช่น `.credentials/ชื่อไฟล์.json` เพื่อไม่ผูกกับชื่อผู้ใช้เครื่องเก่า ไม่ต้องเปลี่ยน quota project หรือบัญชีที่ API ให้สิทธิ์เพียงเพราะย้ายเครื่อง
- **TikTok:** คัดลอก `.credentials/tiktok-oauth.json` ซึ่งมี client registration และ tokens หรือ login ใหม่บน Mac mini อย่าเปิด server สองเครื่องพร้อมกันโดยใช้ refresh token ที่คัดลอกชุดเดียวกัน ควรหยุดเครื่องเดิมก่อนย้าย

## 2. ติดตั้งบน Mac mini

ต้องมี Node.js 22.14+ และ `uv` ใน PATH เช่นติดตั้ง Node.js และ uv ด้วยเครื่องมือที่ใช้อยู่แล้ว จากนั้น:

```sh
cd "$HOME/SocialMediaMCP"
npm run setup:mac
```

คำสั่งนี้ติดตั้ง Node dependencies ตาม lockfile สร้าง Python 3.12 environment และติดตั้ง Google MCP จาก source revision ที่ pin ไว้ ถ้าไม่มี `.env` จะสร้างจากตัวอย่าง และสร้าง `MCP_SERVER_TOKEN` แบบสุ่มเมื่อยังไม่ได้ตั้งค่า โดยไม่พิมพ์ token ออกมา ไม่เขียนทับ Meta/Google credentials เดิม

อย่าคัดลอก `node_modules` หรือ `.venv-google` จากเครื่องเก่า เพราะ virtualenv มี path ของ Python และอาจต่างสถาปัตยกรรม ให้ติดตั้งใหม่บนเครื่องปลายทาง

ถ้าเลือก login TikTok ใหม่:

```sh
npm run tiktok:login
```

เปิด authorization URL ใน browser **บน Mac mini** callback คือ `127.0.0.1:8765` ถ้า login จาก laptop ให้ทำ SSH port forwarding ของพอร์ต 8765 กลับไป Mac mini ก่อน อย่าเปิด server หรือ TikTok login หลาย process พร้อมกันขณะเปลี่ยน credentials

## 3. ตั้งค่า HTTP

แก้ `.env` บน Mac mini:

```dotenv
MCP_HOST=0.0.0.0
MCP_PORT=3000
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],macmini.local,192.168.1.50
```

เปลี่ยน `macmini.local` และ `192.168.1.50` เป็น hostname/IP จริงที่ client จะใช้ ไม่ใส่ scheme หรือ port ใน `MCP_ALLOWED_HOSTS` และเก็บ `MCP_SERVER_TOKEN` ที่ setup สร้างไว้เป็นความลับ

```sh
npm test
npm start
```

เมื่อเชื่อม platform ครบ log จะแสดง `Social Media MCP ready .../mcp` หากแพลตฟอร์มใดตั้งค่าไม่ครบ server จะไม่เปิดพอร์ต ให้ตรวจ `.env` และรัน `npm run meta:tools`, `npm run google:tools`, `npm run tiktok:tools` แยกเพื่อหาส่วนที่ยังไม่พร้อม

Endpoint สำหรับ client:

```text
http://macmini.local:3000/mcp
Authorization: Bearer <ค่า MCP_SERVER_TOKEN จาก .env ของ Mac mini>
```

ตั้งค่า client ให้ใช้ **Streamable HTTP** และส่ง Authorization header ทุก request ไม่ใช้ token ของ Meta/TikTok ในฝั่ง client ส่วน health check คือ `GET /health` และต้องใช้ Bearer token เช่นเดียวกัน

HTTP ส่งข้อมูลและ bearer token แบบไม่เข้ารหัส จึงใช้กับเครือข่ายส่วนตัวที่ไว้ใจได้เท่านั้น สำหรับข้ามอินเทอร์เน็ต ให้ใช้ HTTPS reverse proxy หรือ VPN ที่เข้ารหัส และเพิ่ม hostname ของ endpoint ใน allowlist หากใช้ reverse proxy ต้องส่ง Host header ที่อยู่ใน allowlist ไปยัง server ไม่ได้เตรียมการเปิดพอร์ต router หรือ TLS certificate ให้โดยอัตโนมัติ

## 4. ให้รันอัตโนมัติหลัง login macOS

หยุด `npm start` ใน terminal ก่อน แล้วรัน **บน Mac mini**:

```sh
npm run service:install
```

สร้าง LaunchAgent `com.convertcake.social-media-mcp` โดยใช้ Node executable และ path ของโปรเจกต์บนเครื่องนั้น ตรวจ plist ด้วย `plutil` และโหลด service ให้ทันที ไม่ต้องแก้ path ใน plist เอง หากติดตั้งซ้ำ จะ restart เฉพาะ service นี้

ดู log:

```sh
tail -f logs/server.err.log
```

Restart หลังเปลี่ยน `.env`:

```sh
launchctl kickstart -k "gui/$(id -u)/com.convertcake.social-media-mcp"
```

หยุด service:

```sh
launchctl bootout "gui/$(id -u)/com.convertcake.social-media-mcp"
```

ก่อน login TikTok ใหม่ ให้หยุด service แล้ว login ให้เสร็จ จากนั้นใช้ `npm run service:install` เพื่อเริ่มใหม่

LaunchAgent เริ่มเมื่อผู้ใช้นั้น login และทำงานต่อหลังล็อกหน้าจอ แต่เครื่องต้องตื่นและมีเครือข่าย ไม่ใช่ LaunchDaemon ที่เริ่มก่อน login ถ้าต้องการใช้หลัง reboot โดยไม่ login ต้องเพิ่มการติดตั้งระดับระบบแยกต่างหาก หลังย้ายโฟลเดอร์โปรเจกต์หรือเปลี่ยน Node path ให้รัน installer อีกครั้ง Logs ยังไม่มีการหมุนไฟล์อัตโนมัติ

## ข้อจำกัดที่ต้องรู้

- รัน gateway หนึ่ง process ต่อ credential ชุดนี้ TikTok calls ใน process ถูกจัดคิวเพื่อป้องกัน refresh token ชนกัน แต่ยังไม่มี lock ระหว่างหลาย process
- Meta ใช้ token ที่ให้มาและยังไม่มีระบบต่ออายุอัตโนมัติ TikTok refresh ผ่าน SDK ได้ตราบที่ refresh authorization ยังใช้ได้ Google ใช้ credentials ตามไฟล์/ADC
- tools ถูก snapshot ตอน server เริ่ม Restart เพื่อโหลด tools ใหม่
- ไม่มี UTM extraction tool รวมอยู่ใน gateway การดึง UTM รอบที่ทดสอบใช้ AI เลือก MCP tools แล้วอ่าน nested creative fields ผ่าน Graph API เพิ่ม เพราะ Meta MCP ไม่เปิดทุก tracking field การเปิด gateway ไม่ได้เพิ่มความสามารถของ upstream MCP
- ไม่ได้ติดตั้ง service บนเครื่องปัจจุบัน และต้องตรวจการเข้าถึงจริงจากเครื่อง client หลังย้ายไป Mac mini

อ้างอิง: [MCP SDK HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [uv environments](https://docs.astral.sh/uv/pip/environments/)
