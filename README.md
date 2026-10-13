# Lilya Backstage

Lilya Home için stok, sipariş ve envanter yönetimi.

- Trendyol ve Shopify'da aynı stok koduna sahip ürünler **tek ortak depo stoğunu** kullanır.
- Trendyol siparişleri **her 10 saniyede** otomatik çekilir; uygulama kapalıyken de çalışır.
- İptal edilen siparişlerin stoğu geri eklenir. İade talebi stoğu değiştirmez; ürün depoya ulaşıp kabul edilince stok artar.
- Alış fiyatıyla ürün bazında ve depo toplamında stok değeri gösterilir.

## Kurulum

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ferhatdurre1-prog/lilya-backstage)

1. Yukarıdaki düğmeye bas, Cloudflare hesabınla giriş yap.
2. İstenen alanlara uygulama şifreni ve Trendyol bilgilerini (Satıcı ID, API Key, API Secret) gir.
3. Kurulum bitince Cloudflare panelinden **Workers Paid** paketine geç (10 saniyelik eşitleme için gerekli).
4. Verilen `workers.dev` adresini Safari'de aç, giriş yap ve **Ana Ekrana Ekle**.

## Geliştirme

`source/` klasöründe sunucu (`server.js`) ve arayüz (`app.html`) kaynakları var. `python3 source/build.py` bunları tek dosyaya (`src/worker.js`) birleştirir.
