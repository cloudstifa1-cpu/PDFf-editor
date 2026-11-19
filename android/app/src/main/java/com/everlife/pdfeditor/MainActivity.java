package com.everlife.pdfeditor;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Shows the PDF Editor web app (bundled inside the APK) and connects it to Android:
 * "Open with" / Share for PDFs, saving to Downloads, sharing, picking files, and the Back button.
 */
public class MainActivity extends Activity {
    // Special address Android reserves for app files; gives the page a normal secure https origin.
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/www/index.html";
    static final int PICK_FILES = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private volatile Uri incoming;          // file handed to us by another app
    private volatile String incomingName;
    private volatile boolean incomingWaiting;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(false);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serve(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // Outside links (like "get an API key") open in the phone's browser
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                List<String> types = new ArrayList<>();
                for (String a : params.getAcceptTypes())
                    for (String t : a.split(",")) { t = t.trim(); if (t.contains("/")) types.add(t); }
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                if (types.size() == 1) i.setType(types.get(0));
                else {
                    i.setType("*/*");
                    if (!types.isEmpty()) i.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                }
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(i, PICK_FILES); }
                catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });

        takeIncoming(getIntent());
        if (state != null) web.restoreState(state); else web.loadUrl(START);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (takeIncoming(intent)) web.evaluateJavascript("window.onIncomingFile && window.onIncomingFile()", null);
    }

    /** Remembers a PDF sent by another app ("Open with" or "Share"). */
    private boolean takeIncoming(Intent i) {
        if (i == null) return false;
        Uri u = null;
        if (Intent.ACTION_VIEW.equals(i.getAction())) u = i.getData();
        else if (Intent.ACTION_SEND.equals(i.getAction())) u = i.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u == null) return false;
        incoming = u;
        incomingName = displayName(u);
        incomingWaiting = true;
        return true;
    }

    private String displayName(Uri u) {
        String name = null;
        if ("content".equals(u.getScheme())) {
            try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) { }
        }
        if (name == null) name = u.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "Document.pdf";
        if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
        return name;
    }

    /** Serves the app's own files, and the incoming PDF, to the web page. */
    private WebResourceResponse serve(Uri url) {
        if (!HOST.equals(url.getHost())) return null;   // AI services etc. go to the internet as normal
        String path = url.getPath();
        if (path == null) return notFound();
        try {
            if (path.startsWith("/incoming/")) {
                if (incoming == null) return notFound();
                InputStream in = getContentResolver().openInputStream(incoming);
                return ok("application/pdf", in);
            }
            if (path.startsWith("/www/")) {
                String asset = path.substring(1);
                if (asset.endsWith(".gz")) asset += ".bin";   // see app/build.gradle copyWeb
                return ok(mime(path), getAssets().open(asset));
            }
        } catch (IOException | SecurityException e) {
            return notFound();
        }
        return notFound();
    }

    private static WebResourceResponse ok(String mime, InputStream in) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        String enc = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") ? "utf-8" : null;
        return new WebResourceResponse(mime, enc, 200, "OK", h, in);
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILES || fileCallback == null) return;
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                picked = new Uri[n];
                for (int k = 0; k < n; k++) picked[k] = data.getClipData().getItemAt(k).getUri();
            } else if (data.getData() != null) picked = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /** Things the web page can ask Android to do. */
    class Bridge {
        @JavascriptInterface
        public String getIncoming() {
            if (!incomingWaiting) return "";
            incomingWaiting = false;
            try {
                JSONObject o = new JSONObject();
                o.put("url", "https://" + HOST + "/incoming/" + System.nanoTime());
                o.put("name", incomingName);
                return o.toString();
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public String saveFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "Could not save the file.";
                try (OutputStream out = getContentResolver().openOutputStream(uri)) { out.write(bytes); }
                v.clear();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, v, null, null);
                return "Saved to Downloads: " + name;
            } catch (Exception e) {
                return "Could not save: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String shareFile(String name, String mime, String base64) {
            try {
                File dir = new File(getCacheDir(), "share");
                dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                File f = new File(dir, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                try (FileOutputStream out = new FileOutputStream(f)) { out.write(Base64.decode(base64, Base64.DEFAULT)); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "Share " + name)));
                return "";
            } catch (Exception e) {
                return "Could not share: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String version() { return Build.VERSION.RELEASE; }
    }
}
