package org.agigalaxy.keycloak.management;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/** A separate realm extension; no built-in required action or email SPI is replaced. */
public final class ManagementEmailChangeProviderFactory implements RealmResourceProviderFactory {
    public static final String ID = "galaxy-management";

    @Override
    public RealmResourceProvider create(KeycloakSession session) {
        return new RealmResourceProvider() {
            @Override public Object getResource() { return new ManagementEmailChangeResource(session); }
            @Override public void close() { }
        };
    }

    @Override public String getId() { return ID; }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
