// SPDX-License-Identifier: MIT

/**
 * Higher-order component — wraps a component and injects:
 *  - `configCatClient`: the live `IConfigCatClient` instance.
 *  - `getValue`: a curried wrapper around `client.getValueAsync`.
 *  - `lastUpdated`: the `Date` of the most recent `configChanged` event.
 *
 * Shape and prop names mirror configcat-react@^4.x's
 * `WithConfigCatClientProps` verbatim (research §R14). Class
 * components built against `configcat-react`'s HOC compile unchanged
 * after the import swap.
 */

import type { IConfigCatClient, SettingTypeOf, User } from "@confeature/sdk-browser-js";
import React from "react";

import { ensureConfeatureContext } from "./context.ts";

type SettingValue = boolean | string | number | null;

export type GetValueType = <T extends SettingValue>(
  key: string,
  defaultValue: T,
  user?: User,
) => Promise<SettingTypeOf<T>>;

export interface WithConfigCatClientProps {
  configCatClient: IConfigCatClient;
  getValue: GetValueType;
  lastUpdated?: Date;
}

function bindGetValue(client: IConfigCatClient): GetValueType {
  return <T extends SettingValue>(
    key: string,
    defaultValue: T,
    user?: User,
  ): Promise<SettingTypeOf<T>> => client.getValueAsync(key, defaultValue, user);
}

export function withConfigCatClient<P>(
  WrappedComponent: React.ComponentType<P & WithConfigCatClientProps>,
  providerId?: string,
): React.ComponentType<Omit<P, keyof WithConfigCatClientProps>> {
  const context = ensureConfeatureContext(providerId);

  function WithConfigCatClient(props: Omit<P, keyof WithConfigCatClientProps>): React.ReactElement {
    return (
      <context.Consumer>
        {(ctx): React.ReactElement => {
          if (!ctx) {
            const suffix = providerId ? ` with id="${providerId}"` : "";
            throw new Error(
              `withConfigCatClient must be used within a <ConfigCatProvider>${suffix}`,
            );
          }
          const injected: WithConfigCatClientProps = {
            configCatClient: ctx.client,
            getValue: bindGetValue(ctx.client),
            lastUpdated: ctx.lastUpdated,
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return <WrappedComponent {...(props as any)} {...injected} />;
        }}
      </context.Consumer>
    );
  }

  WithConfigCatClient.displayName = `withConfigCatClient(${
    WrappedComponent.displayName ?? WrappedComponent.name ?? "Component"
  })`;
  return WithConfigCatClient;
}
