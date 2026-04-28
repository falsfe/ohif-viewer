import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { refreshSession } from './authApi';

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

type Props = {
  userAuthenticationService: AppTypes.UserAuthenticationService;
};

export default function LocalAuthRoutes({ userAuthenticationService }: Props) {
  const navigate = useNavigate();

  useEffect(() => {
    userAuthenticationService.set({ enabled: true });

    const getAuthorizationHeader = () => {
      const user = userAuthenticationService.getUser();

      if (!user || !accessToken) {
        return;
      }

      return {
        Authorization: `Bearer ${accessToken}`,
      };
    };

    const handleUnauthenticated = () => {
      const currentPath = window.location.pathname + window.location.search;
      if (currentPath !== '/auth/login') {
        sessionStorage.setItem('ohif-auth-redirect-to', currentPath);
      }
      navigate('/auth/login');
      return null;
    };

    userAuthenticationService.setServiceImplementation({
      getAuthorizationHeader,
      handleUnauthenticated,
    });

    refreshSession()
      .then(result => {
        accessToken = result.accessToken;
        userAuthenticationService.setUser(result.user);
      })
      .catch(() => {
        // Not logged in — PrivateRoute will redirect to /auth/login
      });
  }, []);

  return null;
}
