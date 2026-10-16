import { Icon } from '../ui/Icon';
import { PROVIDER_KEY_URLS } from './providers';
import type { CloudProviderName } from '../../api/types';

/** A plain link to the provider's key page; the shell opens it in the OS browser. */
export function ProviderKeyLink({ provider }: { provider: CloudProviderName }) {
  return (
    <a className="provider-key-link" href={PROVIDER_KEY_URLS[provider]} target="_blank" rel="noopener noreferrer">
      Get a key <Icon name="external" size={12} />
    </a>
  );
}
