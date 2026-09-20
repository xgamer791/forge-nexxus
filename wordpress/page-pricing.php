<?php
/**
 * Pricing: the plan catalog as the deployment serves it, with the packs and
 * the per-request costs. Nothing here is typed in by hand.
 */

defined( 'ABSPATH' ) || exit;

$catalog = forge_catalog();
$costs   = $catalog['requestCosts'] ?? null;
$topups  = $catalog['topUps'] ?? [];
$labels  = [
	'chat'     => [ 'Ask a question', 'Talk through what you want before you build. A reply that is only advice settles at this rate.' ],
	'generate' => [ 'Build a site', 'A complete first version of a page: layout, copy and imagery.' ],
	'edit'     => [ 'Edit a site', 'A follow-up message that changes the page you already have.' ],
	'image'    => [ 'Generate an image', 'A picture made for the site rather than found for it.' ],
	'video'    => [ 'Generate a video', 'Motion for a hero or a background.' ],
];

get_header();
?>

<section class="page-hero">
	<div class="wrap section-head section-head-split">
		<div>
			<h1>Plans and credits</h1>
			<p class="lede">Every plan grants a monthly allowance. Requests hold credits while they run and settle for what they used. One plan covers the mobile app and the web, because it is one account.</p>
		</div>
		<div class="interval-toggle" role="group" aria-label="Billing interval" data-interval-toggle>
			<button type="button" class="is-active" data-interval="month" aria-pressed="true">Monthly</button>
			<button type="button" data-interval="year" aria-pressed="false">Yearly</button>
		</div>
	</div>
</section>

<section class="section pricing-page">
	<div class="wrap">
		<?php forge_render_plans( $catalog, 'pricing' ); ?>
	</div>
</section>

<?php if ( $costs ) : ?>
<section class="section costs alt">
	<div class="wrap costs-grid">
		<div class="section-head">
			<h2>What a request costs</h2>
			<p>The hold is the promise. A request never costs more than it held, and one that fails before it does any work costs nothing.</p>
		</div>
		<table class="cost-table">
			<thead><tr><th scope="col">Request</th><th scope="col">What it is</th><th scope="col">Credits</th></tr></thead>
			<tbody>
			<?php foreach ( $labels as $key => [ $name, $note ] ) : if ( ! isset( $costs[ $key ] ) ) { continue; } ?>
				<tr>
					<th scope="row"><?php echo esc_html( $name ); ?></th>
					<td><?php echo esc_html( $note ); ?></td>
					<td class="cost-num"><?php echo esc_html( number_format( (float) $costs[ $key ] ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
	</div>
</section>
<?php endif; ?>

<?php if ( $topups ) : ?>
<section class="section topups">
	<div class="wrap costs-grid">
		<div class="section-head">
			<h2>Extra credits</h2>
			<p>On plans that allow top-ups, a pack joins the current period's balance and expires with it. Buy them from Plan and credits inside Forge.</p>
		</div>
		<ul class="topup-list">
			<?php foreach ( $topups as $pack ) : ?>
				<li><strong><?php echo esc_html( number_format( (float) $pack['credits'] ) ); ?> credits</strong><span><?php echo esc_html( forge_money( $pack['priceCents'] ) ); ?></span></li>
			<?php endforeach; ?>
		</ul>
	</div>
</section>
<?php endif; ?>

<section class="section faq alt">
	<div class="wrap faq-grid">
		<div class="section-head">
			<h2>Billing questions</h2>
			<p>Anything else: <a href="mailto:<?php echo esc_attr( FORGE_SUPPORT_EMAIL ); ?>"><?php echo esc_html( FORGE_SUPPORT_EMAIL ); ?></a>.</p>
		</div>
		<div class="faq-list">
			<details>
				<summary>When do credits reset?</summary>
				<p>On your billing date each month. The reset date is shown on your credits card and in Plan and credits. Unused credits expire; they do not roll over.</p>
			</details>
			<details>
				<summary>What happens when I run out?</summary>
				<p>Forge tells you what the request needs and what you have. You can still plan and ask questions at the conversation rate; building resumes when you upgrade or top up.</p>
			</details>
			<details>
				<summary>How do upgrades and downgrades work?</summary>
				<p>Upgrades open a fresh period on the new plan straight away, and whatever the old period had left comes along. A downgrade is scheduled for the end of the current period, so nothing is taken from you early.</p>
			</details>
			<details>
				<summary>Is billing the same on mobile and web?</summary>
				<p>Yes. One subscription per account. Manage it from either client; the balance you see is the same everywhere because it lives in one place.</p>
			</details>
		</div>
	</div>
</section>

<section class="section cta-band on-plate">
	<div class="wrap cta-inner">
		<h2>Start free. Upgrade when the first build lands.</h2>
		<div class="button-row">
			<a class="button button-large" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-text="Open Forge">Start building</a>
		</div>
	</div>
</section>

<?php get_footer(); ?>
