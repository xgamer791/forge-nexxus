</main>
<footer class="site-footer">
	<div class="wrap footer-grid">
		<div class="footer-brand">
			<a class="brand" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php echo forge_mark( 'brand-mark' ); ?><span>Forge Nexxus</span></a>
			<p>One product, two clients. Build on your phone, continue on the web — the same account, sites, credits and settings everywhere.</p>
		</div>
		<div class="footer-col">
			<h4>Product</h4>
			<ul class="footer-list">
				<li><a href="<?php echo esc_url( home_url( '/#showcase' ) ); ?>">Showcase</a></li>
				<li><a href="<?php echo esc_url( home_url( '/#how' ) ); ?>">How it works</a></li>
				<li><a href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>">Pricing</a></li>
				<li><a href="<?php echo esc_url( home_url( '/app/' ) ); ?>">Open Forge on the web</a></li>
			</ul>
		</div>
		<div class="footer-col">
			<h4>Account</h4>
			<ul class="footer-list">
				<li><a href="<?php echo esc_url( home_url( '/app/' ) ); ?>">Sign in</a></li>
				<li><a href="<?php echo esc_url( home_url( '/app/?screen=plan' ) ); ?>">Plan &amp; credits</a></li>
				<li><a href="<?php echo esc_url( FORGE_MOBILE_APP_URL ); ?>" rel="noopener">Mobile app</a></li>
			</ul>
		</div>
		<div class="footer-col">
			<h4>Company</h4>
			<?php forge_footer_menu(); ?>
			<a class="footer-mail" href="mailto:<?php echo esc_attr( FORGE_SUPPORT_EMAIL ); ?>"><?php echo esc_html( FORGE_SUPPORT_EMAIL ); ?></a>
		</div>
	</div>
	<div class="wrap footer-base">
		<span>&copy; <?php echo esc_html( gmdate( 'Y' ) ); ?> Forge Nexxus</span>
		<span>The sites you build are yours.</span>
	</div>
</footer>
<?php wp_footer(); ?>
</body>
</html>
