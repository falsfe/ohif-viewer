import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthPageLayout from './AuthPageLayout';
import { login } from './authApi';

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const registered = searchParams.get('registered') === '1';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(usernameOrEmail, password);
      sessionStorage.setItem('accessToken', result.accessToken);
      sessionStorage.setItem('user', JSON.stringify(result.user));
      navigate('/');
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('INVALID_CREDENTIALS') || msg.includes('Invalid')) {
        setError('用户名/邮箱或密码错误');
      } else {
        setError(msg || '登录失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPageLayout title="OHIF Viewer">
      <form onSubmit={handleSubmit} className="space-y-5">
        {registered && (
          <div className="rounded border border-green-400 bg-green-900/20 px-4 py-3 text-sm text-green-400">
            注册成功，请登录
          </div>
        )}
        {error && (
          <div className="rounded border border-red-400 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            用户名 / 邮箱
          </label>
          <input
            type="text"
            value={usernameOrEmail}
            onChange={e => setUsernameOrEmail(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="请输入用户名或邮箱"
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
            placeholder="请输入密码"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-400">
        没有账号？{' '}
        <Link to="/auth/register" className="text-blue-400 hover:text-blue-300">
          去注册
        </Link>
      </p>
    </AuthPageLayout>
  );
}
