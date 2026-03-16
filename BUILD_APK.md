# 📱 APK Oluşturma Rehberi

Bu projeden Android APK oluşturmanın 3 yolu:

---

## Yöntem 1: PWA (Hemen kullanın — kurulum yok)
GitHub Pages'e yükledikten sonra Android Chrome'da:
1. Siteyi açın: `https://KULLANICI.github.io/soy-agaci`
2. Sağ üst menü → **"Ana ekrana ekle"**
3. Uygulama simgesi oluşur ✅

---

## Yöntem 2: PWA Builder (Ücretsiz, kolay APK)
1. [pwabuilder.com](https://pwabuilder.com) adresine gidin
2. URL'nizi girin: `https://KULLANICI.github.io/soy-agaci`
3. **"Build My PWA"** → **Android** → **Generate**
4. `.apk` veya `.aab` indirilir ✅

---

## Yöntem 3: Capacitor ile yerel APK build (Tam kontrol)

### Gereksinimler
- [Android Studio](https://developer.android.com/studio) kurulu olmalı
- Java 17+ kurulu olmalı
- Node.js 18+ kurulu olmalı

### Adımlar

```bash
# 1. Bağımlılıkları yükle
npm install
npm install @capacitor/core @capacitor/cli @capacitor/android

# 2. Capacitor başlat
npx cap init "Soy Ağacı" "com.soyagaci.app" --web-dir dist

# 3. Build al
npm run build

# 4. Android platform ekle
npx cap add android

# 5. Dosyaları kopyala
npx cap sync android

# 6. Android Studio'da aç
npx cap open android
```

### Android Studio'da APK oluştur:
- **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`

### İmzalı (release) APK için:
- **Build** → **Generate Signed Bundle/APK**
- Keystore oluşturun ve imzalayın

---

## Yöntem 4: Otomatik - GitHub Actions ile APK Build

Bu repo'da `.github/workflows/build-apk.yml` dosyası var.
GitHub'a push ettiğinizde otomatik APK oluşturulur.
Actions → Artifacts → apk-release indirin.
