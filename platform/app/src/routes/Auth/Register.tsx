import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthPageLayout from './AuthPageLayout';
import { register } from './authApi';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const backendErrorMap: Record<string, string> = {
  USERNAME_TAKEN: '该用户名已被注册',
  EMAIL_TAKEN: '该邮箱已被注册',
  VALIDATION_ERROR: '输入信息有误，请检查后重试',
};

function mapBackendError(message: string): string {
  for (const [key, zh] of Object.entries(backendErrorMap)) {
    if (message.includes(key) || message.includes(key.replace('_', ' '))) {
      return zh;
    }
  }
  return message || '注册失败，请稍后重试';
}

export default function Register() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!USERNAME_PATTERN.test(username)) {
      setError('用户名须为 3-64 个字符，只能包含字母、数字、下划线、中划线或点');
      return;
    }

    if (!EMAIL_PATTERN.test(email)) {
      setError('请输入有效的邮箱地址');
      return;
    }

    if (password.length < 8) {
      setError('密码至少需要 8 个字符');
      return;
    }

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);

    try {
      await register(username, email, password, confirmPassword);
      navigate('/auth/login?registered=1');
    } catch (err: any) {
      setError(mapBackendError(err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPageLayout title="创建账号">
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded border border-red-400 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            用户名
          </label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="3-64 个字符，字母、数字、_ - ."
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            邮箱
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="请输入邮箱地址"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            密码
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="至少 8 个字符"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            确认密码
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="请再次输入密码"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '注册中...' : '注册'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-400">
        已有账号？{' '}
        <Link to="/auth/login" className="text-blue-400 hover:text-blue-300">
          去登录
        </Link>
      </p>
    </AuthPageLayout>
  );
}
