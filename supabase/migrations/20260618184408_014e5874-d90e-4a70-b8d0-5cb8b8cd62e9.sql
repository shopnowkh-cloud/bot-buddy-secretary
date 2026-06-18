
CREATE POLICY "no public access" ON public.business_connections FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "no public access" ON public.business_messages FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "no public access" ON public.bot_settings FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);
