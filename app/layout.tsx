import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
  title: 'Galaxy 浏览器演示 — 非正式服务',
  description: '仅用于演示 Case、披露与模拟 Proof 流程；不创建真实 Galaxy ID，不连接 Official 或 Hub。',
  applicationName: 'Galaxy browser demo',
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    title: 'Galaxy 浏览器演示 — 非正式服务',
    description: '浏览器模拟 Case、披露和未签名 Proof；不连接本机 Core 或远程服务。',
    images: [{ url: '/og.png', width: 1680, height: 945, alt: 'Galaxy 浏览器演示 — 非正式服务' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Galaxy 浏览器演示 — 非正式服务',
    description: '使用 DEMO 编号的浏览器流程演示，非正式身份或事实记录。',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
