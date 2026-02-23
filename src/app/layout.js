import './globals.css';

export const metadata = {
  title: 'BackLinker – Internal Backlink Recommender',
  description: 'Find the best internal linking opportunities for your new blog posts.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
