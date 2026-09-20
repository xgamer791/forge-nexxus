<?php
/**
 * The home page for anyone who is not signed in: what Forge builds, how, on
 * which plans. Members are redirected to /app/ from header.php.
 */

defined( 'ABSPATH' ) || exit;

$catalog  = forge_catalog();
$costs    = $catalog['requestCosts'] ?? null;
$showcase = [
	[ 'show-cafe', 'A site for my coffee roaster, warm and editorial', 'Coffee roaster' ],
	[ 'show-architecture', 'A black-and-white portfolio for an architecture studio', 'Architecture studio' ],
	[ 'show-saas', 'A landing page for my project-management app with pricing', 'Software product' ],
	[ 'show-boutique', 'A minimalist shop for a clothing boutique', 'Fashion boutique' ],
	[ 'show-restaurant', 'A restaurant site with the dinner menu and reservations', 'Restaurant' ],
	[ 'show-fitness', 'A bold fitness studio site with the class schedule', 'Fitness studio' ],
	[ 'show-realestate', 'A real-estate agency with featured listings', 'Real estate' ],
	[ 'show-portfolio', 'A dark gallery for my landscape photography', 'Photography portfolio' ],
	[ 'show-bakery', 'A website for my bakery, with the menu and opening hours', 'Bakery' ],
	[ 'show-hotel', 'A calm site for a small hotel by the sea, with rooms and booking', 'Boutique hotel' ],
	[ 'show-nonprofit', 'An ocean conservation nonprofit with a donate button', 'Nonprofit' ],
	[ 'show-agency', 'A loud, colourful site for my design agency with case studies', 'Design agency' ],
];
$hero_messages = [
	'World class website designs in minutes',
	'Not just a beautiful design, we aim to scale your business',
	'Fully customized tools with your needs in mind',
	'Legendary customer support that exceeds expectations',
	'Don’t fall behind ai, let it work for you with Forge Nexxus',
];
get_header();
?>

<section class="hero">
	<div class="hero-lockup" aria-hidden="true">
		<?php
		$lockup_unit = '<span>Forge Nexxus</span><span>Forge Nexxus</span><span>Forge Nexxus</span><span>Forge Nexxus</span>';
		for ( $row = 0; $row < 8; $row++ ) :
			?>
			<div class="hero-lockup-row">
				<div class="hero-lockup-run">
					<div class="hero-lockup-unit"><?php echo $lockup_unit; ?></div>
					<div class="hero-lockup-unit"><?php echo $lockup_unit; ?></div>
				</div>
			</div>
		<?php endfor; ?>
	</div>
	<div class="wrap hero-stage">
		<h1 class="visually-hidden">Forge Nexxus</h1>
		<div class="hero-message-rotator" data-hero-messages aria-hidden="true">
			<?php foreach ( $hero_messages as $index => $message ) : ?>
				<p class="hero-message<?php echo 0 === $index ? ' is-active' : ''; ?>"><?php echo esc_html( $message ); ?></p>
			<?php endforeach; ?>
		</div>
		<ul class="visually-hidden">
			<?php foreach ( $hero_messages as $message ) : ?>
				<li><?php echo esc_html( $message ); ?></li>
			<?php endforeach; ?>
		</ul>
		<form class="hero-composer" action="<?php echo esc_url( home_url( '/app/' ) ); ?>" method="get" data-hero-composer>
			<label class="visually-hidden" for="hero-prompt">Describe the site you want</label>
			<textarea id="hero-prompt" name="prompt" rows="1" placeholder="Describe the site you want…" aria-label="Describe your site" autocapitalize="sentences" autocomplete="off" spellcheck="true" maxlength="600"></textarea>
			<div class="toolbar">
				<button class="add" type="button" aria-label="Add images or files" data-hero-add>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg>
				</button>
				<button class="microphone" type="button" aria-label="Start voice input" aria-pressed="false">
					<svg viewBox="0 0 24 28" aria-hidden="true"><rect x="8" y="2" width="8" height="16" rx="4"/><path d="M4 12v3a8 8 0 0 0 16 0v-3M12 23v3"/></svg>
				</button>
			</div>
		</form>
	</div>
	<figure class="hero-visual">
		<img src="<?php echo esc_url( forge_img( 'hero-spread.jpg' ) ); ?>" srcset="<?php echo esc_url( forge_img( 'hero-spread-1200.jpg' ) ); ?> 1200w, <?php echo esc_url( forge_img( 'hero-spread.jpg' ) ); ?> 2400w" sizes="100vw" width="2400" height="1018" alt="Five websites built with Forge Nexxus in browser windows: a coffee roaster, an architecture studio, a software dashboard, a fashion boutique and a travel journal." fetchpriority="high">
	</figure>
</section>

<section class="section showcase" id="showcase">
	<div class="wrap section-head">
		<h2>Sites people ask Forge for</h2>
		<p>Each of these started as one sentence. The build thread remembers the site, so the next sentence changes it instead of starting over. Pick one to open the prompt in Forge.</p>
	</div>
	<div class="wrap showcase-grid">
		<?php foreach ( $showcase as [ $file, $prompt, $label ] ) : ?>
			<a class="show-card" href="<?php echo esc_url( home_url( '/app/?prompt=' . rawurlencode( $prompt ) ) ); ?>">
				<img src="<?php echo esc_url( forge_img( $file . '.jpg' ) ); ?>" srcset="<?php echo esc_url( forge_img( $file . '-800.jpg' ) ); ?> 800w, <?php echo esc_url( forge_img( $file . '.jpg' ) ); ?> 1600w" sizes="(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 720px) 50vw, 100vw" width="1600" height="1195" alt="<?php echo esc_attr( $label . ' website built with Forge Nexxus' ); ?>" loading="lazy">
				<span class="show-meta"><span class="show-label"><?php echo esc_html( $label ); ?></span><span class="show-prompt"><?php echo esc_html( $prompt ); ?></span></span>
			</a>
		<?php endforeach; ?>
	</div>
</section>

<section class="section how alt" id="how">
	<div class="wrap section-head">
		<h2>How it works</h2>
		<p>Three moves. There are no templates to pick through and no editor to learn.</p>
	</div>
	<ol class="wrap steps">
		<li class="step">
			<span class="step-n">1</span>
			<h3>Describe it</h3>
			<img src="<?php echo esc_url( forge_img( 'how-prompt.jpg' ) ); ?>" width="1000" height="1000" alt="A composer holding the prompt: a website for my bakery." loading="lazy">
			<p>Say what the site is for, who it is for and the tone you want. Type it or speak it. The first message names the site.</p>
		</li>
		<li class="step">
			<span class="step-n">2</span>
			<h3>Forge builds it</h3>
			<img src="<?php echo esc_url( forge_img( 'how-build.jpg' ) ); ?>" width="1000" height="1000" alt="A website assembling from layered sections." loading="lazy">
			<p>A complete page comes back in the thread: layout, copy and imagery. Ask for changes in plain language; each reply is a new version you can preview the moment it lands.</p>
		</li>
		<li class="step">
			<span class="step-n">3</span>
			<h3>Publish, then keep going</h3>
			<img src="<?php echo esc_url( forge_img( 'how-publish.jpg' ) ); ?>" width="1000" height="1000" alt="A finished bakery website on a monitor and a phone." loading="lazy">
			<p>Publish to a Forge address in one tap, point your own domain at it on Premium, or download the code. Come back from any device and pick up the thread.</p>
		</li>
	</ol>
</section>

<section class="section continuity">
	<div class="wrap continuity-grid">
		<div class="continuity-copy">
			<h2>Start on your phone. Finish on your laptop.</h2>
			<p>Forge Nexxus is one product with two clients, the way your chat apps are. Sign in here with the same email, Google or Apple account you use in the app and everything is already waiting.</p>
			<ul class="check-list">
				<li>Every site and its full build thread</li>
				<li>Your plan, credits and usage history</li>
				<li>Appearance and other settings</li>
				<li>Published addresses and custom domains</li>
			</ul>
			<div class="button-row">
				<a class="button" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-text="Open Forge">Open Forge on the web</a>
				<a class="button button-ghost" href="<?php echo esc_url( FORGE_MOBILE_APP_URL ); ?>" rel="noopener">Get the mobile app</a>
			</div>
		</div>
		<figure class="continuity-visual">
			<img src="<?php echo esc_url( forge_img( 'continuity.jpg' ) ); ?>" width="1376" height="768" alt="The same Forge Nexxus build thread open on a laptop, with the live preview beside it, and on a phone." loading="lazy">
		</figure>
	</div>
</section>

<section class="section features alt" id="features">
	<div class="wrap section-head">
		<h2>Everything a site needs, nothing you have to run</h2>
		<p>Forge is the whole stack: the design, the build, the hosting and the address.</p>
	</div>
	<div class="wrap feature-grid">
		<article class="feature">
			<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/></svg>
			<h3>A thread that remembers</h3>
			<p>Every site has its own conversation. Ask for a darker header or a new section and Forge edits the page you already have.</p>
		</article>
		<article class="feature">
			<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14"/><path d="M3 9h18M8 21h8"/></svg>
			<h3>Live preview</h3>
			<p>See each version in a sandboxed frame the moment it lands. On the web the preview sits beside the thread while you work.</p>
		</article>
		<article class="feature">
			<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12M6 9l6-6 6 6M4 21h16"/></svg>
			<h3>Publish in one tap</h3>
			<p>Your site gets a stable Forge address that survives unpublishing and republishing. Links keep working.</p>
		</article>
		<article class="feature">
			<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
			<h3>Your own domain</h3>
			<p>On Premium, point a domain you own at any site. It stays pending until publishing verifies your DNS, then it is live.</p>
		</article>
		<article class="feature">
			<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>
			<h3>Download the code</h3>
			<p>Paid plans can take the page as a single HTML file, exactly as the preview shows it. It is yours.</p>
		</article>
		<article class="feature">
			<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20V11M10 20V4M16 20v-7M2 20h20"/></svg>
			<h3>Credits you can see</h3>
			<p>Each request shows what it holds before it runs and what it cost in your usage ledger after. A failed build costs nothing.</p>
		</article>
	</div>
</section>

<section class="section pricing-preview" id="pricing">
	<div class="wrap section-head section-head-split">
		<div>
			<h2>Plans and credits</h2>
			<p>Pick a monthly allowance. Builds hold credits while they run and settle for what they used; unused credits do not roll over.</p>
		</div>
		<div class="interval-toggle" role="group" aria-label="Billing interval" data-interval-toggle>
			<button type="button" class="is-active" data-interval="month" aria-pressed="true">Monthly</button>
			<button type="button" data-interval="year" aria-pressed="false">Yearly</button>
		</div>
	</div>
	<div class="wrap">
		<?php forge_render_plans( $catalog, 'home' ); ?>
		<?php if ( $costs ) : ?>
			<p class="cost-line">A full site build holds <?php echo esc_html( number_format( (float) $costs['generate'] ) ); ?> credits, an edit <?php echo esc_html( number_format( (float) $costs['edit'] ) ); ?> and a question <?php echo esc_html( number_format( (float) $costs['chat'] ) ); ?>. <a href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>">See the full pricing details</a>.</p>
		<?php endif; ?>
	</div>
</section>

<section class="section faq alt" id="faq">
	<div class="wrap faq-grid">
		<div class="section-head">
			<h2>Questions</h2>
			<p>The short answers. Support has the long ones at <a href="mailto:<?php echo esc_attr( FORGE_SUPPORT_EMAIL ); ?>"><?php echo esc_html( FORGE_SUPPORT_EMAIL ); ?></a>.</p>
		</div>
		<div class="faq-list">
			<details>
				<summary>Is the website a different product from the mobile app?</summary>
				<p>No. It is the same Forge Nexxus on a bigger screen: one account, one database, one set of sites and credits. Anything you do here shows up in the app, and the other way round.</p>
			</details>
			<details>
				<summary>How do I sign in on the web?</summary>
				<p>With the method you use in the app: an email link, Google or Apple. There is no password, and a guest who signs in keeps what they were working on.</p>
			</details>
			<details>
				<summary>What is a credit?</summary>
				<p>The unit every request is measured in. A site build holds a fixed amount while it runs and settles for what it cost, never more. A question costs a fraction of a build, and a failed request is released in full.</p>
			</details>
			<details>
				<summary>Do unused credits roll over?</summary>
				<p>No. Each plan grants its allowance every month, and the leftover expires when the period renews. Top-up credits, on plans that allow them, join the current period and expire with it.</p>
			</details>
			<details>
				<summary>Where does my site live once it is published?</summary>
				<p>At a Forge address chosen from the site's name and kept for as long as the site exists. Premium adds custom domains, and paid plans can download the page as a file.</p>
			</details>
			<details>
				<summary>Can I cancel?</summary>
				<p>Any time, from Plan and credits. Your plan ends when the period does and you keep your credits until then. Your sites stay.</p>
			</details>
		</div>
	</div>
</section>

<section class="section cta-band on-plate">
	<div class="wrap cta-inner">
		<h2>Build your first site tonight.</h2>
		<p>Describe it in a sentence and Forge does the rest.</p>
		<div class="button-row">
			<a class="button button-large" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-text="Open Forge">Start building</a>
			<a class="button button-ghost button-large" href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>">See pricing</a>
		</div>
	</div>
</section>

<?php get_footer(); ?>
