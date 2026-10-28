# Comisión Clara

Aplicación web instalable para gestionar comisiones y pagos compartidos entre dispositivos. Está hecha con HTML, CSS y JavaScript; los datos sincronizados se guardan en Supabase y el sitio estático se publica en GitHub Pages.

## Funciones

- Vendedores y productos con comisión fija por unidad.
- Comisiones con monto, producto, vendedor, cantidad, fecha y nota.
- Pagos parciales con historial editable, descarga de recibos PDF y saldo actualizado.
- Acceso con correo y contraseña. Solo las cuentas autorizadas en Supabase pueden usar la base.
- Sincronización de cambios entre dispositivos conectados a internet.
- Exportación e importación de respaldos JSON y CSV.
- Montos en MXN y fechas dd/mm/aaaa.

## Configurar Supabase (una sola vez)

1. En el proyecto de Supabase, abre **SQL Editor → New query**.
2. Copia y ejecuta el contenido de `supabase/setup.sql`. Esto crea las tablas, las políticas RLS y la validación de pagos.
3. Abre **Authentication → Users** y crea una cuenta por persona que necesite acceso. Si solo una persona usará la app en tres dispositivos, basta una cuenta, iniciando sesión en los tres.
4. En la tabla de usuarios, copia el UUID de cada cuenta recién creada. En SQL Editor ejecuta una consulta como la siguiente, sustituyendo los UUID y nombres:

   ```sql
   insert into public.commission_members (user_id, display_name, role)
   values
     ('UUID-DE-LA-CUENTA-1', 'Nombre 1', 'admin'),
     ('UUID-DE-LA-CUENTA-2', 'Nombre 2', 'operator'),
     ('UUID-DE-LA-CUENTA-3', 'Nombre 3', 'operator');
   ```

   Omite las filas de cuentas que no creaste. Esta autorización se hace desde SQL Editor; el formulario público de la aplicación no permite crear cuentas ni acceder a datos.
5. En `supabase-config.js` están la URL del proyecto y la clave **publishable**. Esa clave está diseñada para aparecer en apps de navegador; las políticas RLS limitan los datos a miembros. Nunca pongas una clave `sb_secret_` ni `service_role` en los archivos web.
6. Abre la aplicación publicada en cada dispositivo e inicia sesión con una cuenta autorizada.

Si la base está vacía y el dispositivo tiene datos guardados en la versión local anterior, al iniciar sesión la aplicación preguntará si quieres importarlos a la base compartida.

## Publicar con GitHub Pages

1. Sube todos los archivos y la carpeta `supabase/` al nivel principal del repositorio.
2. En GitHub, abre **Settings → Pages**.
3. En **Build and deployment**, selecciona **Deploy from a branch**, la rama `main` y la carpeta `/(root)`.
4. Guarda los cambios y espera a que termine la publicación. Abre el enlace HTTPS de Pages en cada dispositivo.

## Datos y operación

La base compartida requiere internet para consultar y sincronizar cambios. Descarga respaldos desde **Ajustes y respaldo** con regularidad. GitHub Pages guarda el código público, no los registros financieros. El recibo PDF de cada pago incluye nombre del vendedor, fecha, monto y concepto del producto.

La comisión total es `cantidad × comisión por unidad`. El saldo restante es `comisión total − suma de pagos`. La base rechaza fechas de pago futuras y pagos que superen el saldo; la aplicación limita los montos a dos decimales.
