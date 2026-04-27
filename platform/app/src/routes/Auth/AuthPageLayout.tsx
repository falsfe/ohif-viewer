import React from 'react';

type Props = {
  title: string;
  children: React.ReactNode;
};

export default function AuthPageLayout({ title, children }: Props) {
  return (
    <div className="absolute flex h-full w-full items-center justify-center bg-black/95">
      <div className="w-full max-w-md rounded-xl bg-black px-8 py-10 shadow-lg">
        <h1 className="mb-8 text-center text-2xl font-semibold text-white">
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}