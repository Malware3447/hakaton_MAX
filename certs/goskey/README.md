# Сертификаты для проверки подписи «Госключа» (HAKATON-41)

Доверяем только корням из `unep/` и `ukep/`. Промежуточные из `intermediate/` доверия не добавляют: они лишь помогают собрать цепочку без сети; недостающие скачиваются по адресу из сертификата подписанта.

- `unep/` — «Специализированный центр сертификации», корень УНЭП «Госключа». Источник: goskey.ru, раздел «Корневые сертификаты УНЭП» (архив certs.zip).
- `intermediate/` — «Госуслуги. Неквалифицированная электронная подпись», тот же архив.
- `ukep/` — головной УЦ Минцифры (2022) и Минкомсвязи (2018), корни квалифицированных сертификатов. Источник: reestr-pki.ru/cdp/guc2022.crt и guc_gost12.crt.

Отпечатки SHA-1:

- `intermediate/gosuslugi-nep-2021.pem` — EB:73:FC:45:A5:C0:4D:42:B7:34:B6:E8:40:DC:58:09:F0:84:AE:99
- `intermediate/gosuslugi-nep-2023.pem` — 5B:21:BB:A6:C0:09:11:97:5C:C0:7D:4D:94:8F:BA:FF:9A:0E:D1:C2
- `intermediate/gosuslugi-nep-2024-2.pem` — 2F:B7:42:41:47:9D:5C:A9:EA:52:35:29:23:19:F7:33:F7:96:F3:C6
- `intermediate/gosuslugi-nep-2024.pem` — 57:66:9F:B9:B9:46:5E:87:A1:FC:32:65:6B:DF:09:5A:8C:2E:60:DA
- `intermediate/gosuslugi-nep-2025-3.pem` — 67:2F:90:3B:2C:9E:9E:A8:43:1F:E3:02:CF:BB:68:CE:14:22:9E:28
- `intermediate/gosuslugi-nep-2025-4.pem` — B6:BF:43:CA:7D:77:1C:26:C1:49:60:9F:A7:86:13:D8:A2:46:9A:FE
- `intermediate/gosuslugi-nep-2025.pem` — 51:0A:2E:66:E9:3C:1A:A6:69:02:29:20:27:02:04:56:64:39:DB:C3
- `ukep/mincifry-guc-2022.pem` — 2F:0C:B0:9B:E3:55:0E:F1:7E:C4:F2:9C:90:AB:D1:8B:FC:AA:D6:3A
- `ukep/minkomsvyaz-guc-2018.pem` — 4B:C6:DC:14:D9:70:10:C4:1A:26:E0:58:AD:85:1F:81:C8:42:41:5A
- `unep/scc-2023.pem` — F5:7B:49:D7:0D:37:27:83:E4:4D:6E:E5:E9:90:1A:57:7B:F5:8D:91
- `unep/scc-2026.pem` — BE:EA:17:90:19:75:F1:FC:AD:BA:55:13:19:35:6F:39:FC:A3:63:BB
