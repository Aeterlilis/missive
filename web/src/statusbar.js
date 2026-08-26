// 状态栏配色。装成应用之后，手机顶上那条系统状态栏（时间、电量、信号）由页面的
// <meta name="theme-color"> 决定颜色——不跟着界面配色走的话，用户把界面调成夜间深色，
// 顶上还杵着一条白，一眼出戏。
//
// 三个页面各自算出界面底色之后都调一下这里，写死在 HTML 里那个白色只是没读到设置前的兜底。

export function syncStatusBarColor(hex) {
  if (!hex) return;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', hex);
}
