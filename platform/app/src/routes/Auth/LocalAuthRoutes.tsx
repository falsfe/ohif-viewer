import { useEffect } from 'react';
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
    const getAuthorizationHeader = () => {
      return;
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
        userAuthenticationService.set({ enabled: true });
      })
      .catch(() => {
        userAuthenticationService.set({ enabled: true });
      });
  }, []);

  return null;
}
