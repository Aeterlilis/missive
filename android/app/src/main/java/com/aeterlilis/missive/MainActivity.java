package com.aeterlilis.missive;

import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.DisplayCutoutCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import java.util.Locale;

/**
 * 安卓版的入口。除了"铺满屏幕"这件事，其余一切都由 BridgeActivity 处理——界面就是
 * assets/public 里那份 web/，跟网页版逐字一致。
 *
 * 做 APK 的头号理由就是全屏：网页版装到主屏幕之后顶上永远留着一条系统状态栏，纸纹背景和
 * 自定义背景图被它齐刷刷截断，而 display:fullscreen 在挖孔屏上只会把那一截换成一条黑带
 * （实测，viewport-fit=cover 也拿不回来）。原生应用没有这个限制。
 *
 * 这里干三件事：收起系统栏、让窗口画进挖孔那一圈、把挖孔的尺寸告诉页面。
 */
public class MainActivity extends BridgeActivity {

    /** 最近一次拿到的挖孔尺寸（物理像素）。页面换一页要重新告诉它，所以得存着。 */
    private Insets cutout = Insets.NONE;

    /** 挖孔在屏幕左右两侧那两条边上伸到多深（物理像素）。挖孔只占正中间时是 0。 */
    private int cutoutAtEdges = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 必须放在 super 之后：BridgeActivity.onCreate 里会 setTheme 换主题、建 bridge，
        // 那之前动窗口属性或者取 webView 都不作数。
        drawIntoCutout();
        hideSystemBars();
        watchCutout();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 从后台切回来、或者用户从边缘划出系统栏之后，系统栏会赖着不走，重新收一次。
        if (hasFocus) {
            hideSystemBars();
        }
    }

    /**
     * 允许窗口画到挖孔/刘海那一圈里去。不声明的话系统会替我们让开，那一截就成了黑带。
     */
    private void drawIntoCutout() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return;
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                // ALWAYS 横竖屏都画进去；SHORT_EDGES 只管竖屏，是 API 30 以下的退路。
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        getWindow().setAttributes(params);
    }

    /**
     * 收起状态栏和导航栏，纸面铺满整块屏幕。
     *
     * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE：从屏幕边缘往里划能临时把系统栏叫回来看一眼
     * （看时间、回桌面），松手一会儿自己又收回去，不会把页面顶掉一块重新布局。
     */
    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    /**
     * 把挖孔的尺寸算出来交给页面，自己不动版面。
     *
     * Capacitor 自带的那套（SystemBars 插件的 insetsHandling）在这件事上帮倒忙：WebView 的
     * 版本低于 140 时，它会给 WebView 的父容器加一圈 padding 把整个页面从挖孔底下推出来
     * ——纸面于是又铺不到屏幕边缘了，正是做 APK 要解决的那个问题。所以配置里把它关掉
     * （capacitor.config.json 的 plugins.SystemBars.insetsHandling = "disable"），改成这里
     * 自己听：不加 padding、不消费，只把数值写成 CSS 变量。
     *
     * 只取挖孔、不取系统栏：系统栏平时是收起来的，用户划一下临时叫出来时不该让整个版面跳一下。
     *
     * 页面那边读的是 max(env(safe-area-inset-top), var(--safe-area-inset-top))，见
     * web/chrome-theme.css——新版 WebView 自己就把 env() 报对了，老版本靠这里注入的变量兜底。
     */
    private void watchCutout() {
        View parent = (View) bridge.getWebView().getParent();

        ViewCompat.setOnApplyWindowInsetsListener(parent, (v, insets) -> {
            cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            cutoutAtEdges = measureCutoutAtEdges(insets.getDisplayCutout(), v.getWidth());
            publishCutout();
            return insets; // 原样传下去，不加 padding 也不消费
        });

        // 每换一页都要重新注入：变量是写在 document 上的，页面一跳就没了。
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                publishCutout();
            }
        });

        parent.requestApplyInsets();
    }

    /**
     * 挖孔在左右两条边上伸到多深。
     *
     * 顶上那一截不该一律拿来当留白：挖孔在正中间（大多数国产机、水滴屏、居中的刘海）时，
     * 贴在左上角和右上角的那些图标压根碰不到它，全都往下推只会在顶上空出一条很难看的白。
     * 所以只看挖孔有没有真的伸进左右各四分之一那两条边里去——伸进来了才让开。
     *
     * 左右取同一个值：左边那列工具栏和右上角那组入口在视觉上是一对，必须齐平，
     * 一边贴顶一边下沉比多留一点白更难看。
     */
    private int measureCutoutAtEdges(DisplayCutoutCompat cutoutInfo, int viewWidth) {
        if (cutoutInfo == null) return 0;
        int width = viewWidth > 0 ? viewWidth : getResources().getDisplayMetrics().widthPixels;
        if (width <= 0) return 0;

        int band = width / 4;
        int deepest = 0;
        for (Rect r : cutoutInfo.getBoundingRects()) {
            boolean touchesEdge = r.left < band || r.right > width - band;
            if (touchesEdge) deepest = Math.max(deepest, r.bottom);
        }
        // 别超过挖孔本身报出来的顶部间距：有些机器的 boundingRect 会把整条状态栏都算进去。
        return Math.min(deepest, cutout.top);
    }

    private void publishCutout() {
        float density = getResources().getDisplayMetrics().density;
        String script = String.format(
                Locale.US,
                "document.documentElement.style.setProperty('--safe-area-inset-top','%dpx');"
                        + "document.documentElement.style.setProperty('--safe-area-inset-right','%dpx');"
                        + "document.documentElement.style.setProperty('--safe-area-inset-bottom','%dpx');"
                        + "document.documentElement.style.setProperty('--safe-area-inset-left','%dpx');"
                        + "document.documentElement.style.setProperty('--safe-area-edge-top','%dpx');",
                (int) (cutout.top / density),
                (int) (cutout.right / density),
                (int) (cutout.bottom / density),
                (int) (cutout.left / density),
                (int) (cutoutAtEdges / density));
        runOnUiThread(() -> bridge.getWebView().evaluateJavascript(script, null));
    }
}
