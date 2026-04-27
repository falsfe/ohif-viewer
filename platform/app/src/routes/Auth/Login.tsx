import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthPageLayout from './AuthPageLayout';
import { login } from './authApi';

export default function Login() {
  const navigate = useNavigate();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      setError(err.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPageLayout title="OHIF Viewer">
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded border border-red-400 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            Username or Email
          </label>
          <input
            type="text"
            value={usernameOrEmail}
            onChange={e => setUsernameOrEmail(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="Enter username or email"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="Enter password"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Logging in...' : 'Log In'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-400">
        Don&apos;t have an account?{' '}
        <Link to="/auth/register" className="text-blue-400 hover:text-blue-300">
          Register
        </Link>
      </p>
    </AuthPageLayout>
  );
}