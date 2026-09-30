# Viduki Resolver API + Source Checker

خدمة Node.js بواجهة فحص عربية ومسارات API لتنفيذ التدفق الرسمي للموقع:

- حل Altcha Proof-of-Work.
- الحصول على bootstrap nonce وpepper-key.
- فك pepper وenvelope عبر `makima.a0d5c2ffd2859979.wasm`.
- قراءة قائمة السيرفرات تلقائيًا من `/main/servers`.
- فحص جميع السيرفرات معًا على دفعات محدودة.
- دعم الأفلام والمسلسلات بالموسم والحلقة.

## التشغيل

```bash
npm install
npm start
```

المنفذ الافتراضي `8787` ويمكن تغييره عبر `PORT`.

## الواجهة

افتح:

```text
http://localhost:8787/
```

ثم اختر فيلمًا أو مسلسلًا، أدخل TMDB ID، وللمسلسل أدخل الموسم والحلقة. الواجهة تعرض عدد السيرفرات، حالة كل سيرفر، والرابط الناتج إن وجد.

الموقع يرجع حاليًا **13 سيرفرًا**، لكن التطبيق لا يثبت العدد يدويًا؛ بل يقرأ القائمة تلقائيًا من الموقع عند كل فحص.

## API

### قائمة السيرفرات

```http
GET /servers
```

### فحص مصدر واحد

```bash
curl -X POST http://localhost:8787/resolve \
  -H 'content-type: application/json' \
  -d '{"type":"movie","tmdb_id":533535,"server":"Leon"}'
```

للمسلسلات:

```bash
curl -X POST http://localhost:8787/resolve \
  -H 'content-type: application/json' \
  -d '{"type":"tv","tmdb_id":1399,"season":1,"episode":1,"server":"Leon"}'
```

### فحص جميع السيرفرات

```bash
curl -X POST http://localhost:8787/resolve-all \
  -H 'content-type: application/json' \
  -d '{"type":"movie","tmdb_id":533535}'
```

للمسلسلات:

```bash
curl -X POST http://localhost:8787/resolve-all \
  -H 'content-type: application/json' \
  -d '{"type":"tv","tmdb_id":1399,"season":1,"episode":1}'
```

الاستجابة تحتوي `servers`, و`results`, و`success_count`. كل نتيجة تحتوي اسم السيرفر، الحالة، `stream_url` أو سبب الفشل.

## متغيرات البيئة

- `PORT`: منفذ الخدمة، افتراضيًا `8787`.
- `VIDUKI_API_BASE`: عنوان API، افتراضيًا `https://api.viduki.net`.
- `VIDUKI_ORIGIN`: Origin الموقع، افتراضيًا `https://www.viduki.net`.
- `CORS_ORIGIN`: أصل CORS المسموح به؛ يفضّل ضبطه على نطاق تطبيقك بدل `*` في الإنتاج.

الروابط الناتجة مؤقتة وموقعة، لذلك لا تُخزّنها طويلًا ولا تسجل nonces أو استجابات pepper في logs.
