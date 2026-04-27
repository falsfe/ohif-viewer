import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthPageLayout from './AuthPageLayout';
import { register } from './authApi';

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

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      await register(username, email, password, confirmPassword);
      navigate('/auth/login?registered=1');
    } catch (err: any) {
      setError(err.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPageLayout title="Create Account">
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded border border-red-400 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="3-64 characters, letters, numbers, _ - ."
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="Enter email address"
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
            placeholder="At least 8 characters"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            Confirm Password
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            required
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            placeholder="Re-enter password"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Creating account...' : 'Register'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-gray-400">
        Already have an account?{' '}
        <Link to="/auth/login" className="text-blue-400 hover:text-blue-300">
          Log In
        </Link>
      </p>
    </AuthPageLayout>
  );
}