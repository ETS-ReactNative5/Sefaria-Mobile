#!/bin/bash
. ./keystore_pass.sh  # include KEYSTORE_PASS variable
KEYSTORE="kstore.jks"
APK_DIR="app/build/outputs/apk/release"
curl "http://localhost:8081/index.android.bundle?platform=android" -o "app/src/main/assets/index.android.bundle"
./gradlew assembleRelease
jarsigner -tsa http://timestamp.comodoca.com/rfc3161 -sigalg SHA1withRSA -digestalg SHA1 -keystore $KEYSTORE -storepass $KEYSTORE_PASS $APK_DIR/app-release-unsigned.apk kstore
jarsigner -verify $APK_DIR/app-release-unsigned.apk
zipalign -f 4 $APK_DIR/app-release-unsigned.apk $APK_DIR/app-release-signed.apk
