import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ToIV — AI 创作平台",
  description: "Film Atelier · AI 驱动的影视创作工作台",
};

export const viewport: Viewport = {
  // Obsidian 深色单主题
  themeColor: "#0B0B0F",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const themeInitScript = `(function(){
  try {
    var stored = localStorage.getItem('toiv_theme');
    var theme = stored || 'auto';
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    
    function applyTheme(t) {
      if (t === 'auto') {
        document.documentElement.dataset.theme = mql.matches ? 'dark' : 'light';
      } else {
        document.documentElement.dataset.theme = t;
      }
    }
    
    applyTheme(theme);
    document.documentElement.dataset.themeMode = theme;
    
    mql.addEventListener('change', function() {
      if (document.documentElement.dataset.themeMode === 'auto') {
        applyTheme('auto');
      }
    });
  } catch(e) {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.themeMode = 'auto';
  }
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a href="#main" className="skip-link">跳到主内容</a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
