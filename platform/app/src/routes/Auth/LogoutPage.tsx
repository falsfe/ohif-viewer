import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserAuthentication } from '@ohif/ui-next';
import { logout as authLogout } from './authApi';
import { setAccessToken } from './LocalAuthRoutes';

export default function LogoutPage() {
  const navigate = useNavigate();
  const [, { reset }] = useUserAuthentication();

  useEffect(() => {
    const doLogout = async () => {
      try {
        await authLogout();
      } catch {
        // Ignore — token may already be expired
      }
      setAccessToken(null);
      reset();
      navigate('/auth/login');
    };
    doLogout();
  }, []);

  return (
    <div className="absolute flex h-full w-full items-center justify-center text-white">
      正在退出登录...
    </div>
  );
}
