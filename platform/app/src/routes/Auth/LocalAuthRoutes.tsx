import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { refreshSession } from './authApi';

let accessToken: string | null = null;

export const OWNED_UIDS_CACHE_KEY = 'ohif_owned_uids';

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (!token) {
    sessionStorage.removeItem(OWNED_UIDS_CACHE_KEY);
  }
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
      if (accessToken) {
        return { Authorization: `Bearer ${accessToken}` };
      }
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
